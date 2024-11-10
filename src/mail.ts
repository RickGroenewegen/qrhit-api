import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import fs from 'fs/promises';
import path from 'path';
import Templates from './templates';
import { Payment } from '@prisma/client';
import { Playlist } from './interfaces/Playlist';
import Translation from './translation';
import PushoverClient from './pushover';
import Utils from './utils';
import axios from 'axios';
import { decode } from 'he';
import { CronJob } from 'cron';
import { PrismaClient } from '@prisma/client';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import cluster from 'cluster';

const prisma = new PrismaClient();

interface MailParams {
  to: string | null;
  from: string;
  subject: string;
  html: string;
  text: string;
  attachments: Attachment[];
  unsubscribe: string;
  replyTo?: string;
}

interface Attachment {
  contentType: string;
  filename: string;
  data: string;
  isInline?: boolean;
  cid?: string;
}

class Mail {
  private static instance: Mail;
  private ses: SESClient | null = null;
  private templates: Templates = new Templates();
  private translation: Translation = new Translation();
  private pushover = new PushoverClient();
  private utils = new Utils();
  private logger = new Logger();

  private constructor() {
    this.initializeSES();
    this.initializeCron();
  }

  public static getInstance(): Mail {
    if (!Mail.instance) {
      Mail.instance = new Mail();
    }
    return Mail.instance;
  }

  private initializeSES(): void {
    this.ses = new SESClient({
      credentials: {
        accessKeyId: process.env['AWS_SES_ACCESS_KEY_ID']!,
        secretAccessKey: process.env['AWS_SES_SECRET_KEY_ID']!,
      },
      region: process.env['AWS_SES_REGION'],
    });
  }

  private async initializeCron(): Promise<void> {
    const isMainServer = await this.utils.isMainServer();
    if (
      (isMainServer || process.env['ENVIRONMENT'] === 'development') &&
      cluster.isPrimary
    ) {
      this.startCron();
    }
  }

  public startCron(): void {
    // Initialize cron job to run at 3 AM
    new CronJob(
      '*/10 * * * * *',
      () => {
        this.uploadContacts();
      },
      null,
      true
    );
  }

  async sendContactForm(data: any, ip: string): Promise<void> {
    const { captchaToken, ...otherData } = data;

    // // Verify reCAPTCHA token
    const isHuman = await this.utils.verifyRecaptcha(captchaToken);

    if (!isHuman) {
      throw new Error('reCAPTCHA verification failed');
    }

    const subject = otherData.subject;

    const message = `
    <p><strong>Name:</strong> ${otherData.name}</p>
    <p><strong>E-mail:</strong> ${otherData.email}</p>
    <p><strong>Message:</strong> ${otherData.message}</p>`;

    const rawEmail = await this.renderRaw({
      from: `${data.name} <${process.env['FROM_EMAIL']}>`,
      to: process.env['INFO_EMAIL']!,
      subject: `${process.env['PRODUCT_NAME']} Contact form`,
      html: message,
      text: message,
      attachments: [] as Attachment[],
      unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
      replyTo: data.email,
    });

    const emailBuffer = Buffer.from(rawEmail);

    // Prepare and send the raw email
    const command = new SendRawEmailCommand({
      RawMessage: {
        Data: emailBuffer,
      },
    });

    if (this.ses) {
      const result = await this.ses.send(command);
      this.pushover.sendMessage(
        {
          title: `QRSong! Contactformulier`,
          message: `Nieuw bericht: van ${data.email}`,
          sound: 'incoming',
        },
        ip
      );
    }
  }

  async sendEmail(
    orderType: string,
    payment: any,
    playlists: Playlist[] | [],
    filename: string = '',
    filenameDigital: string = ''
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    let numberOfTracks = 0;

    // Calculate the total number of tracks
    for (const playlist of playlists) {
      numberOfTracks += playlist.numberOfTracks;
    }

    const translations = await this.translation.getTranslationsByPrefix(
      payment.locale,
      'mail'
    );

    const sendPhysicalLink =
      filename &&
      filename.length > 0 &&
      orderType == 'digital' &&
      this.utils.isTrustedEmail(payment.email!);

    const mailParams = {
      payment,
      playlists,
      orderId: payment.orderId,
      fullname: payment.fullname,
      email: payment.email,
      address: payment.address,
      city: payment.city,
      zipcode: payment.zipcode,
      country: payment.countrycode,
      invoiceAddress: payment.invoiceAddress,
      invoiceCity: payment.invoiceCity,
      invoiceZipcode: payment.invoiceZipcode,
      invoiceCountry: payment.invoiceCountrycode,
      differentInvoiceAddress: payment.differentInvoiceAddress,
      digitalDownloadLink: `${process.env['API_URI']}/download/${payment.paymentId}/${payment.user.hash}/${playlists[0].playlistId}/digital`,
      downloadLink: `${process.env['API_URI']}/download/${payment.paymentId}/${payment.user.hash}/${playlists[0].playlistId}/printer`,
      sendPhysicalLink,
      numberOfTracks,
      productName: process.env['PRODUCT_NAME'],
      translations,
      countries: await this.translation.getTranslationsByPrefix(
        payment.locale,
        'countries'
      ),
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      let locale = payment.locale;

      let templateName = orderType;

      const html = await this.templates.render(
        `mails/${templateName}_html`,
        mailParams
      );
      const text = await this.templates.render(
        `mails/${templateName}_text`,
        mailParams
      );

      let subject = '';

      if (orderType === 'digital') {
        subject = this.translation.translate(
          'mail.mailSubjectDigital',
          locale,
          {
            orderId: payment.orderId,
            playlist: playlists[0].name,
          }
        );
      } else if (orderType === 'voucher_digital') {
        subject = this.translation.translate('mail.mailSubjectVoucher', locale);
      } else if (orderType === 'voucher_physical') {
        subject = this.translation.translate(
          'mail.mailSubjectVoucherPhysical',
          locale
        );
      } else if (playlists.length == 1) {
        subject = this.translation.translate('mail.mailSubject', locale, {
          orderId: payment.orderId,
          playlist: playlists[0].name,
        });
      } else {
        subject = this.translation.translate('mail.mailSubject', locale, {
          orderId: payment.orderId,
        });
      }

      subject = decode(subject);

      let attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      if (orderType === 'voucher_physical' || orderType === 'voucher_digital') {
        const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;
        const fileBuffer = await fs.readFile(filePath);
        const fileBase64 = this.wrapBase64(fileBuffer.toString('base64'));
        attachments.push({
          contentType: 'application/pdf',
          filename: 'voucher.pdf',
          data: fileBase64,
        });
      }

      if (
        orderType === 'voucher_physical' &&
        filename &&
        filename.length > 0 &&
        this.utils.isTrustedEmail(payment.email!)
      ) {
        const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
        const fileBuffer = await fs.readFile(filePath);
        const fileBase64 = this.wrapBase64(fileBuffer.toString('base64'));
        attachments.push({
          contentType: 'application/pdf',
          filename: 'voucher_printer.pdf',
          data: fileBase64,
        });
      }

      const rawEmail = await this.renderRaw({
        from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
        to: payment.email,
        subject,
        html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
        text,
        attachments,
        unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
      });

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
    } catch (error) {
      console.error('Error while sending email with attachment', error);
    }
  }

  async sendTrackingEmail(
    payment: Payment,
    trackingLink: string,
    invoicePath: string
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    const mailParams = {
      payment,
      trackingLink,
      productName: process.env['PRODUCT_NAME'],
      translations: await this.translation.getTranslationsByPrefix(
        payment.locale,
        'mail'
      ),
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      let locale = payment.locale;

      const html = await this.templates.render(
        `mails/tracking_html`,
        mailParams
      );
      const text = await this.templates.render(
        `mails/tracking_text`,
        mailParams
      );

      const subject = this.translation.translate(
        'mail.trackingMailSubject',
        locale,
        {
          orderId: payment.orderId,
        }
      );

      let attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      if (invoicePath.length > 0) {
        // Read the PDF file and convert it to Base64
        const fileBuffer = await fs.readFile(invoicePath);
        const fileBase64 = this.wrapBase64(fileBuffer.toString('base64'));

        attachments.push({
          contentType: 'application/pdf',
          filename: 'invoice.pdf',
          data: fileBase64,
        });
      }

      const rawEmail = await this.renderRaw({
        from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
        to: payment.email,
        subject,
        html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
        text,
        attachments,
        unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
        replyTo: process.env['REPLY_TO_EMAIL'],
      });

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
    } catch (error) {
      console.error('Error while sending email with attachment', error);
    }
  }

  public async renderRaw(params: MailParams): Promise<string> {
    let attachmentString = '';

    for (const attachment of params.attachments) {
      const contentDisposition = attachment.isInline
        ? `Content-Disposition: inline; filename="${attachment.filename}"\nContent-ID: <${attachment.cid}>`
        : `Content-Disposition: attachment; filename="${attachment.filename}"`;

      attachmentString += `
--MixedBoundaryString
Content-Type: ${attachment.contentType}
Content-Transfer-Encoding: base64
${contentDisposition}

${attachment.data}
`;
    }

    const replyToHeader = params.replyTo ? `Reply-To: ${params.replyTo}\n` : '';

    const rawEmail = `From: ${params.from}
To: ${params.to}
${
  process.env['ENVIRONMENT'] !== 'development' && process.env['INFO_EMAIL']
    ? `Bcc: ${process.env['INFO_EMAIL']}\n`
    : ''
}Subject: ${params.subject}
${replyToHeader}MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="MixedBoundaryString"
List-Unsubscribe: <${process.env['UNSUBSCRIBE_EMAIL']}>

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

  private wrapBase64(base64: string): string {
    return base64.replace(/(.{76})/g, '$1\n');
  }

  private async uploadContacts(): Promise<void> {
    try {
      this.logger.log(
        color.blue.bold('Starting daily contact upload to Mail Octopus')
      );

      // Get all users who opted in for marketing emails
      const users = await prisma.user.findMany({
        where: {
          marketingEmails: true,
        },
        select: {
          email: true,
          displayName: true,
          createdAt: true,
        },
      });

      if (users.length === 0) {
        this.logger.log(color.yellow('No marketing contacts found to upload'));
        return;
      }

      // Format contacts for Mail Octopus API
      const contacts = users.map((user) => ({
        email: user.email,
        fields: {
          FirstName: user.displayName,
          SignupDate: user.createdAt.toISOString(),
        },
        status: 'SUBSCRIBED',
      }));

      // Mail Octopus API endpoint - replace LIST_ID with your actual list ID
      const apiUrl =
        'https://emailoctopus.com/api/1.6/lists/d652bc66-9f55-11ef-b995-1d6900e1c2ff/contacts';
      const apiKey = process.env.MAIL_OCTOPUS_API_KEY;

      // Upload contacts in batches of 100 (Mail Octopus recommendation)
      const batchSize = 100;
      for (let i = 0; i < contacts.length; i += batchSize) {
        const batch = contacts.slice(i, i + batchSize);

        for (const contact of batch) {
          console.log(111, contact);

          try {
            const result = await axios.post(apiUrl, {
              api_key: apiKey,
              ...contact,
            });

            console.log(222, result.data);
          } catch (err: any) {
            // Log individual contact errors but continue with others
            this.logger.log(
              color.red(
                `Error uploading contact ${white.bold(
                  contact.email
                )}: ${white.bold(err.message)}`
              )
            );
            console.log(err);
          }
        }
      }

      this.logger.log(
        color.blue.bold(
          `Successfully uploaded ${white.bold(
            contacts.length
          )} contacts to Mail Octopus`
        )
      );
    } catch (error: any) {
      this.logger.log(
        color.red(`Error during contact upload: ${white.bold(error.message)}`)
      );

      // Notify admin about the error through Pushover
      if (this.pushover) {
        await this.pushover.sendMessage(
          {
            title: `${process.env['PRODUCT_NAME']} Contact Upload Error`,
            message: `Error during daily contact upload: ${error.message}`,
            sound: 'falling',
          },
          '127.0.0.1'
        );
      }
    }
  }
}

export default Mail;
