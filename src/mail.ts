import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import fs from 'fs/promises';
import path from 'path';
import Templates from './templates';
import { Payment } from '@prisma/client';
import { Playlist } from './interfaces/Playlist';
import Translation from './translation';
import { count } from 'console';

interface MailParams {
  to: string | null;
  from: string;
  subject: string;
  html: string;
  text: string;
  attachments: Attachment[];
  unsubscribe: string;
}

interface Attachment {
  contentType: string;
  filename: string;
  data: string; // This will hold the base64 encoded data of the attachment
}

class Mail {
  private ses: SESClient | null = null;
  private templates: Templates = new Templates();
  private translation: Translation = new Translation();

  constructor() {
    this.ses = new SESClient({
      credentials: {
        accessKeyId: process.env['AWS_SES_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['AWS_SES_SECRET_KEY_ID']!,
      },
      region: process.env['AWS_SES_REGION'],
    });
  }

  async sendEmail(
    payment: Payment,
    playlist: Playlist,
    filename: string
  ): Promise<void> {
    if (!this.ses) return;

    const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
    const mailParams = {
      payment,
      playlist,
      downloadLink: `${process.env['API_URI']}/public/pdf/${filename}`,
      orderId: payment.orderId,
      fullname: payment.fullname,
      email: payment.email,
      address: payment.address,
      city: payment.city,
      zipcode: payment.zipcode,
      country: payment.countrycode,
      numberOfTracks: playlist.numberOfTracks,
      productName: process.env['PRODUCT_NAME'],
      translations: this.translation.getTranslationsByPrefix(
        payment.locale,
        'mail'
      ),
    };

    try {
      // Read the PDF file and convert it to Base64
      const fileBuffer = await fs.readFile(filePath as string);
      const fileBase64 = fileBuffer.toString('base64');

      // Get the filename from the path
      const filename = path.basename(filePath as string);

      let locale = payment.locale;

      const html = await this.templates.render(`mails/ses_html`, mailParams);
      const text = await this.templates.render(`mails/ses_text`, mailParams);

      const subject = this.translation.translate('mail.mailSubject', locale, {
        orderId: payment.orderId,
        playlist: playlist.name,
      });

      const rawEmail = await this.renderRaw({
        from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
        to: payment.email,
        subject,
        html,
        text,
        attachments: [
          {
            contentType: 'application/pdf',
            filename,
            data: fileBase64,
          },
        ],
        unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
      });

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      const data = await this.ses.send(command);
    } catch (error) {
      console.error('Error while sending email with attachment', error);
    }
  }

  public async renderRaw(params: MailParams): Promise<string> {
    let attachmentString = '';

    for (const attachment of params.attachments) {
      attachmentString += `
--MixedBoundaryString
Content-Type: ${attachment.contentType}
Content-Transfer-Encoding: base64
Content-Disposition: attachment; filename="${attachment.filename}"

${attachment.data}
`;
    }

    const rawEmail = `From: ${params.from}
To: ${params.to}
Subject: ${params.subject}
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="MixedBoundaryString"
List-Unsubscribe: <mailto:${params.unsubscribe}>

--MixedBoundaryString
Content-Type: multipart/alternative; boundary="AltBoundaryString"

--AltBoundaryString
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: 7bit

${params.text}

--AltBoundaryString
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: 7bit

${params.html}

--AltBoundaryString--${attachmentString}
--MixedBoundaryString--`;

    return rawEmail;
  }
}

export default Mail;
