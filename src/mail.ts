import { color } from 'console-log-colors';
import Logger from './logger';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import fs from 'fs/promises';
import path from 'path';
import Templates from './templates';

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

  constructor() {
    this.ses = new SESClient({
      credentials: {
        accessKeyId: process.env['AWS_SES_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['AWS_SES_SECRET_KEY_ID']!,
      },
      region: process.env['AWS_SES_REGION'],
    });
  }

  async sendEmail(): Promise<void> {
    if (!this.ses) return;

    const filePath = `${process.env['PUBLIC_DIR']}/pdf/de foute lijst_a09f11a3-2148-4c0f-88de-8c79d396d0a4.pdf`;

    const testData = {
      foo: 'bar',
      test: 123,
    };

    try {
      // Read the PDF file and convert it to Base64
      const fileBuffer = await fs.readFile(filePath as string);
      const fileBase64 = fileBuffer.toString('base64');

      // Get the filename from the path
      const filename = path.basename(filePath as string);

      const html = await this.templates.render('mails/ses_html', testData);
      const text = await this.templates.render('mails/ses_text', testData);

      const rawEmail = await this.renderRaw({
        from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
        to: 'west14@gmail.com',
        subject: `Test mail PDF QRSong`,
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
