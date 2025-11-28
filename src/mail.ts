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
import crypto from 'crypto';
import cluster from 'cluster';
import OpenAI from 'openai';
import { ChatService } from './chat';

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
  private openai = new OpenAI({ apiKey: process.env['OPENAI_TOKEN'] });

  private constructor() {
    this.initializeSES();
    this.initializeCron();
  }

  /**
   * Send a password reset email to a user.
   * @param email The user's email address
   * @param fullname The user's full name
   * @param resetToken The password reset token
   * @param locale The user's locale (default: 'en')
   */
  public async sendPasswordResetMail(
    email: string,
    fullname: string,
    resetToken: string,
    locale: string = 'en'
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    // Fetch translations for password reset mail
    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'password_reset'
    );

    const resetLink = `${process.env['FRONTEND_URI']}/${locale}/account/reset-password/${resetToken}`;

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      resetLink,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/password_reset_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/password_reset_text',
        mailParams
      );

      const subject = this.translation.translate(
        'password_reset.subject',
        locale
      );

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for password reset emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(`Password reset email sent to ${white.bold(email)}`)
      );
    } catch (error) {
      console.error('Error while sending password reset email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send password reset email to ${white.bold(
            email
          )}: ${error}`
        )
      );
    }
  }

  /**
   * Send a QRSong activation email for activating purchased cards.
   * @param email The user's email address
   * @param fullname The user's full name
   * @param userHash The user's hash for activation
   * @param locale The user's locale (default: 'en')
   * @param activationCode The 6-digit activation code
   */
  public async sendQRSongActivationMail(
    email: string,
    fullname: string,
    userHash: string,
    locale: string = 'en',
    activationCode?: string
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    // Fetch translations for QRSong activation mail
    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'qrgames_activation'
    );

    const activationLink = `nl.rickgroenewegen.qrsong://activation?hash=${userHash}`;

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      activationLink,
      activationCode,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/qrgames_activation_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/qrgames_activation_text',
        mailParams
      );

      const subject = this.translation.translate(
        'qrgames_activation.subject',
        locale
      );

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for activation emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(
          `QRGames! activation email sent to ${white.bold(email)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Failed to send QRGames! activation email to ${white.bold(
            email
          )}: ${error}`
        )
      );
    }
  }

  /**
   * Send a QRSong verification email to a user for account verification.
   * @param email The user's email address
   * @param fullname The user's full name
   * @param verificationHash The verification hash for the user
   * @param locale The user's locale (default: 'en')
   */
  public async sendQRSongVerificationMail(
    email: string,
    fullname: string,
    verificationHash: string,
    locale: string = 'en'
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    // Fetch translations for QRSong verification mail
    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'qrsong_verification'
    );

    const verificationLink = `${process.env['FRONTEND_URI']}/${locale}/account/verify/${verificationHash}`;

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      verificationLink,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/qrsong_verification_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/qrsong_verification_text',
        mailParams
      );

      const subject = this.translation.translate(
        'qrsong_verification.subject',
        locale
      );

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for verification emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(
          `QRSong verification email sent to ${white.bold(email)}`
        )
      );
    } catch (error) {
      console.error('Error while sending QRSong verification email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send QRSong verification email to ${white.bold(
            email
          )}: ${error}`
        )
      );
    }
  }

  /**
   * Send a QRVote welcome email to a user for account verification.
   * @param email The user's email address
   * @param fullname The user's full name
   * @param companyName The company name
   * @param locale The user's locale (default: 'nl')
   */
  public async sendQRVoteWelcomeEmail(
    email: string,
    fullname: string,
    companyName: string,
    locale: string = 'nl',
    verificationHash: string
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    // Fetch translations for QRVote welcome mail
    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'qrvote_welcome'
    );

    const verifyUrl = `${process.env['FRONTEND_URI']}/${locale}/account/verify/${verificationHash}`;

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      companyName,
      verifyUrl,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/qrvote_welcome_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/qrvote_welcome_text',
        mailParams
      );

      const subject = `Welcome to QRVote!`;

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for QRVote welcome emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(`QRVote welcome email sent to ${white.bold(email)}`)
      );
    } catch (error) {
      console.error('Error while sending QRVote welcome email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send QRVote welcome email to ${white.bold(
            email
          )}: ${error}`
        )
      );
    }
  }

  /**
   * Send a portal welcome email to a user with their portal credentials.
   * @param email The user's email address
   * @param fullname The user's full name
   * @param companyName The company name
   * @param portalUrl The portal URL
   * @param username The username for the portal
   * @param password The password for the portal
   * @param locale The user's locale (default: 'nl')
   */
  public async sendPortalWelcomeEmail(
    email: string,
    fullname: string,
    companyName: string,
    portalUrl: string,
    username: string,
    password: string,
    locale: string = 'nl',
    adminUrl?: string // new param for admin URL
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/onzevibe_logo.png`;

    // Fetch translations for portal welcome mail
    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'portal_welcome'
    );

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      companyName,
      portalUrl,
      adminUrl,
      username,
      password,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/portal_welcome_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/portal_welcome_text',
        mailParams
      );

      const subject = `Welkom bij je OnzeVibe portal!`;

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'onzevibe_logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'onzevibe_logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `OnzeVibe <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace(
            '<img src="logo.png"',
            '<img src="cid:onzevibe_logo"'
          ),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for portal welcome emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(`Portal welcome email sent to ${white.bold(email)}`)
      );
    } catch (error) {
      console.error('Error while sending portal welcome email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send portal welcome email to ${white.bold(
            email
          )}: ${error}`
        )
      );
    }
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
      '0 3 * * *',
      () => {
        this.uploadContacts();
      },
      null,
      true
    );
  }

  async sendContactForm(data: any, ip: string): Promise<void> {
    const { captchaToken, ...otherData } = data;

    // Verify reCAPTCHA token
    const isHuman = await this.utils.verifyRecaptcha(captchaToken);

    if (!isHuman) {
      throw new Error('reCAPTCHA verification failed');
    }

    // Log contact form submission with user's IP
    this.logger.log(
      color.cyan.bold(
        `Contact form submitted by ${white.bold(otherData.email)} from IP ${white.bold(ip)}`
      )
    );
    this.logger.log(
      color.cyan(
        `  Name: ${white(otherData.name)}, Subject: ${white(otherData.subject || 'N/A')}`
      )
    );

    // Store in database (locale will be detected from message)
    const contactEmail = await prisma.contactEmail.create({
      data: {
        name: otherData.name,
        email: otherData.email,
        subject: otherData.subject || null,
        message: otherData.message,
        locale: null, // Will be detected by AI
        ip: ip,
      },
    });

    // Run translation, draft generation, email notification, and pushover in background (don't block response)
    this.processContactFormBackground(contactEmail.id, otherData, data.name, ip);
  }

  /**
   * Process contact form background tasks (translation, draft reply, email notification, pushover)
   * This runs asynchronously after the API response is sent
   */
  private async processContactFormBackground(
    emailId: number,
    otherData: any,
    senderName: string,
    ip: string
  ): Promise<void> {
    // Translate message to Dutch
    this.translateContactEmailToDutch(emailId, otherData.message);

    // Generate draft reply using AI knowledge base (with tool calling support)
    this.generateDraftReply(emailId, otherData.message, otherData.name, otherData.email);

    // Send notification email to admin
    const message = `
    <p><strong>Name:</strong> ${otherData.name}</p>
    <p><strong>E-mail:</strong> ${otherData.email}</p>
    <p><strong>Message:</strong> ${otherData.message}</p>`;

    const rawEmail = await this.renderRaw({
      from: `${senderName} <${process.env['FROM_EMAIL']}>`,
      to: process.env['INFO_EMAIL']!,
      subject: `${process.env['PRODUCT_NAME']} Contact form`,
      html: message,
      text: message,
      attachments: [] as Attachment[],
      unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
      replyTo: otherData.email,
    });

    const emailBuffer = Buffer.from(rawEmail);

    const command = new SendRawEmailCommand({
      RawMessage: {
        Data: emailBuffer,
      },
    });

    if (this.ses) {
      await this.ses.send(command);
      this.pushover.sendMessage(
        {
          title: `QRSong! Contactformulier`,
          message: `Nieuw bericht: van ${otherData.email}`,
          sound: 'incoming',
        },
        ip
      );
    }
  }

  /**
   * Detect language and translate contact email message to Dutch using function calling
   */
  private async translateContactEmailToDutch(emailId: number, message: string): Promise<void> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Detect the language of the text and translate it to Dutch. Use the provided function to return both the detected language code and the Dutch translation.',
          },
          { role: 'user', content: message },
        ],
        functions: [
          {
            name: 'processTranslation',
            description: 'Process the detected language and Dutch translation of the message',
            parameters: {
              type: 'object',
              properties: {
                detectedLocale: {
                  type: 'string',
                  description: 'ISO 639-1 language code of the detected language (e.g., en, nl, de, fr, es, it, pt, pl, sv, ru, cn, jp, hin)',
                },
                dutchTranslation: {
                  type: 'string',
                  description: 'The message translated to Dutch. If the original is already in Dutch, return the original text.',
                },
              },
              required: ['detectedLocale', 'dutchTranslation'],
            },
          },
        ],
        function_call: { name: 'processTranslation' },
      });

      const functionCall = response.choices[0]?.message?.function_call;
      if (functionCall?.arguments) {
        const result = JSON.parse(functionCall.arguments);
        const { detectedLocale, dutchTranslation } = result;

        await prisma.contactEmail.update({
          where: { id: emailId },
          data: {
            locale: detectedLocale,
            translatedMessage: dutchTranslation,
          },
        });
        this.logger.log(color.green(`[ContactEmail] Detected locale: ${detectedLocale}, translated message ${emailId} to Dutch`));
      }
    } catch (error) {
      this.logger.log(color.red(`[ContactEmail] Translation error: ${error}`));
    }
  }

  /**
   * Generate a draft reply for a contact email using AI knowledge base (async, doesn't block)
   * Uses ChatService's processToolsForContext for tool calling (e.g., shipping status lookup)
   */
  private async generateDraftReply(emailId: number, message: string, customerName: string, customerEmail: string): Promise<void> {
    try {
      // Use ChatService to get relevant topics and process tools
      const chatService = new ChatService();
      const topics = await chatService.getTopics(message, []);

      // Process tools with customer email as additional data for tool execution
      // This allows tools like getShippingStatus to use the customer's email
      const { toolContext, knowledgeContext } = await chatService.processToolsForContext(
        message,
        topics,
        [], // No chat history for contact form emails
        { email: customerEmail } // Pass customer email for tool execution
      );

      // Generate draft reply with knowledge and tool results
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: `You are writing a professional, friendly email reply on behalf of Rick from QRSong!.
Write the reply in Dutch. Be warm and helpful.

IMPORTANT FORMATTING:
- Start with a friendly greeting using the customer's first name
- Be thorough and detailed in your response (this is an email, not a chat - be comprehensive)
- Use proper email formatting with paragraphs
- End with a friendly closing and sign off with just "Rick," (the email template already adds "QRSong!" below)
- If you cannot fully answer based on the knowledge provided, include a helpful response anyway and mention that Rick will follow up with more details if needed
${knowledgeContext}${toolContext}`,
          },
          {
            role: 'user',
            content: `Customer "${customerName}" (${customerEmail}) sent the following message:\n\n${message}\n\nWrite a helpful email reply in Dutch.`,
          },
        ],
      });

      const draftReply = response.choices[0]?.message?.content;
      if (draftReply) {
        await prisma.contactEmail.update({
          where: { id: emailId },
          data: { draftReply },
        });
        this.logger.log(color.green(`[ContactEmail] Generated draft reply for email ${emailId}`));
      }
    } catch (error) {
      this.logger.log(color.red(`[ContactEmail] Draft reply generation error: ${error}`));
    }
  }

  /**
   * Translate content to a specific locale
   */
  public async translateToLocale(content: string, targetLocale: string): Promise<string> {
    const localeNames: { [key: string]: string } = {
      en: 'English',
      de: 'German',
      fr: 'French',
      es: 'Spanish',
      it: 'Italian',
      pt: 'Portuguese',
      pl: 'Polish',
      sv: 'Swedish',
      jp: 'Japanese',
      cn: 'Chinese',
    };

    const targetLang = localeNames[targetLocale] || 'English';

    try {
      const result = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `Translate the following Dutch text to ${targetLang}. Keep any formatting intact. Only return the translation, nothing else.`,
          },
          { role: 'user', content },
        ],
      });

      return result.choices[0]?.message?.content || content;
    } catch (error) {
      this.logger.log(color.red(`[translateToLocale] Error: ${error}`));
      return content;
    }
  }

  async sendEmail(
    orderType: string,
    payment: any,
    playlists: Playlist[] | [],
    filename: string = '',
    filenameDigital: string = '',
    invoicePath: string = ''
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
      housenumber: payment.housenumber,
      city: payment.city,
      zipcode: payment.zipcode,
      country: payment.countrycode,
      invoiceAddress: payment.invoiceAddress,
      invoiceHousenumber: payment.invoiceHousenumber,
      invoiceCity: payment.invoiceCity,
      invoiceZipcode: payment.invoiceZipcode,
      invoiceCountry: payment.invoiceCountrycode,
      differentInvoiceAddress: payment.differentInvoiceAddress,
      digitalDownloadCorrectionLink: `${process.env['FRONTEND_URI']}/${payment.locale}/usersuggestions/${payment.paymentId}/${payment.user.hash}/${playlists[0].playlistId}/1`,
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

      // Attach invoice PDF if provided
      if (invoicePath.length > 0) {
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

  async sendFinalizedMail(
    payment: Payment,
    reviewLink: string,
    playlist: any
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    const mailParams = {
      payment,
      playlist,
      reviewLink,
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
        `mails/finalized_html`,
        mailParams
      );
      const text = await this.templates.render(
        `mails/finalized_text`,
        mailParams
      );

      const subject = decode(
        this.translation.translate('mail.finalizedMailSubject', locale, {
          orderId: payment.orderId,
          playlist: playlist.name,
        })
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

  async sendToPrinterMail(
    payment: Payment & { user: { hash: string } },
    playlist: any
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    const translations = await this.translation.getTranslationsByPrefix(
      payment.locale,
      'mail'
    );
    

    const mailParams = {
      payment,
      playlist,
      orderId: payment.orderId,
      numberOfTracks: playlist.tracks?.length || 0,
      digitalDownloadLink: `${process.env['API_URI']}/download/${payment.paymentId}/${payment.user.hash}/${playlist.playlistId}/digital`,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      let locale = payment.locale;

      const html = await this.templates.render(
        `mails/send_to_printer_html`,
        mailParams
      );
      const text = await this.templates.render(
        `mails/send_to_printer_text`,
        mailParams
      );

      const subject = decode(
        this.translation.translate('mail.sendToPrinterMailSubject', locale, {
          orderId: payment.orderId,
          playlist: playlist.name,
        })
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

  public async renderRaw(
    params: MailParams,
    sendBCC: boolean = true
  ): Promise<string> {
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
  process.env['ENVIRONMENT'] !== 'development' &&
  process.env['BCC_EMAIL'] &&
  sendBCC
    ? `Bcc: ${process.env['BCC_EMAIL']}\n`
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

  async sendReviewEmail(payment: Payment): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    const reviewLink = `${process.env['FRONTEND_URI']}/${payment.locale}/review/${payment.paymentId}`;
    const reviewLinkTrustPilot =
      'https://www.trustpilot.com/evaluate/qrsong.io';
    // Get the payment user
    const user = await prisma.user.findUnique({
      where: { id: payment.userId },
    });

    const unsubscribeLink = `${process.env['FRONTEND_URI']}/${payment.locale}/unsubscribe/${user?.hash}`;

    const mailParams = {
      payment,
      unsubscribeLink,
      reviewLink,
      reviewLinkTrustPilot,
      productName: process.env['PRODUCT_NAME'],
      translations: await this.translation.getTranslationsByPrefix(
        payment.locale,
        'mail'
      ),
      currentYear: new Date().getFullYear(),
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render('mails/review_html', mailParams);
      const text = await this.templates.render('mails/review_text', mailParams);

      const subject = this.translation.translate(
        'mail.reviewMailSubject',
        payment.locale,
        {
          orderId: payment.orderId,
        }
      );

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

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

      // Update reviewMailSent flag
      await prisma.payment.update({
        where: { id: payment.id },
        data: { reviewMailSent: true },
      });
    } catch (error) {
      console.error('Error while sending review email:', error);
    }
  }

  private wrapBase64(base64: string): string {
    return base64.replace(/(.{76})/g, '$1\n');
  }

  public async subscribeToNewsletter(
    email: string,
    captchaToken: string
  ): Promise<boolean> {
    // Verify reCAPTCHA token
    const isHuman = await this.utils.verifyRecaptcha(captchaToken);

    if (!isHuman) {
      throw new Error('Verification failed');
    }

    try {
      // Try to find existing user
      const existingUser = await prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        // Update existing user
        await prisma.user.update({
          where: { email },
          data: {
            marketingEmails: true,
            sync: true,
          },
        });
      } else {
        // Create new user
        const hash = crypto.randomBytes(8).toString('hex').slice(0, 16);
        await prisma.user.create({
          data: {
            email,
            userId: email,
            displayName: email.split('@')[0],
            hash: hash,
            marketingEmails: true,
            sync: true,
          },
        });
      }
      return true;
    } catch (error) {
      console.error('Error subscribing to newsletter:', error);
      return false;
    }
  }

  public async unsubscribe(hash: string): Promise<boolean> {
    try {
      // First try to find the user
      const user = await prisma.user.findUnique({
        where: { hash },
      });

      if (!user) {
        return false;
      }

      // Update the user if found
      await prisma.user.update({
        where: { id: user.id },
        data: {
          marketingEmails: false,
          sync: true, // Trigger sync to update Mail Octopus
        },
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  public async sendVerificationEmail(
    email: string,
    fullname: string,
    companyName: string,
    verificationHash: string,
    locale: string,
    slug?: string,
    isQrvote: boolean = false
  ): Promise<void> {
    if (!this.ses) return;

    // Choose logo and template based on isQrvote flag
    const logoPath = isQrvote
      ? `${process.env['ASSETS_DIR']}/images/logo.png`
      : `${process.env['ASSETS_DIR']}/images/onzevibe_logo.png`;
    const logoContentId = isQrvote ? 'qrsong_logo' : 'onzevibe_logo';
    const templatePrefix = isQrvote
      ? 'mails/qrvote_verification'
      : 'mails/verification';
    const brandName = isQrvote ? 'QRSong!' : 'OnzeVibe';

    // Use the company domain if provided, otherwise fall back to FRONTEND_URI
    const verificationLink = `${process.env['FRONTEND_VOTING_URI']}/hitlist/${slug}/verify/${verificationHash}`;

    const translations = await this.translation.getTranslationsByPrefix(
      locale,
      'verification'
    );

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      companyName,
      verificationLink,
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
      translations,
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        `${templatePrefix}_html`,
        mailParams
      );
      const text = await this.templates.render(
        `${templatePrefix}_text`,
        mailParams
      );

      const subject = `${this.translation.translate(
        'verification.subject',
        locale
      )} - ${brandName}`;

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: isQrvote ? 'qrsong_logo.png' : 'onzevibe_logo.png',
          data: logoBase64,
          isInline: true,
          cid: logoContentId,
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${brandName} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html,
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        false // No BCC for verification emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      // Prepare and send the raw email
      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(`Verification email sent to ${white.bold(email)}`)
      );
    } catch (error) {
      console.error('Error while sending verification email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send verification email to ${white.bold(email)}: ${error}`
        )
      );
    }
  }

  private async completeUserInformation(): Promise<void> {
    try {
      this.logger.log(
        color.blue.bold('Completing user information from payment data')
      );

      // Get all users without country
      const usersWithoutCountry = await prisma.user.findMany({
        where: {
          country: null,
        },
        select: {
          id: true,
          email: true,
        },
      });

      if (usersWithoutCountry.length === 0) {
        this.logger.log(color.yellow.bold('No users without country found'));
        return;
      }

      this.logger.log(
        color.blue.bold(
          `Found ${white.bold(
            usersWithoutCountry.length
          )} users without country`
        )
      );

      // Update each user with country from their payments
      for (const user of usersWithoutCountry) {
        const payment = await prisma.payment.findFirst({
          where: {
            email: user.email,
            countrycode: { not: null },
          },
          orderBy: { createdAt: 'desc' },
          select: { countrycode: true },
        });

        if (payment && payment.countrycode) {
          await prisma.user.update({
            where: { id: user.id },
            data: {
              country: payment.countrycode,
              sync: true,
            },
          });
          this.logger.log(
            color.blue.bold(
              `Updated country for ${white.bold(user.email)} to ${white.bold(
                payment.countrycode
              )} and marked for sync`
            )
          );
        }
      }
    } catch (error: any) {
      this.logger.log(
        color.red(
          `Error completing user information: ${white.bold(error.message)}`
        )
      );
    }
  }

  public async uploadContacts(): Promise<void> {
    try {
      this.logger.log(
        color.blue.bold('Starting daily contact upload to Mail Octopus')
      );

      // First complete user information
      await this.completeUserInformation();

      // Define country codes array
      const countryCodes = ['NL'];

      // Build lists object dynamically
      const lists: { [key: string]: string | undefined } = {
        general: process.env['MAIL_OCTOPUS_LIST_ID'],
      };

      // Add country-specific lists only if environment variable exists
      for (const countryCode of countryCodes) {
        const envKey = `MAIL_OCTOPUS_LIST_ID_${countryCode}`;
        const listId = process.env[envKey];
        if (listId) {
          lists[countryCode] = listId;
        }
      }

      // Get all users
      const users = await prisma.user.findMany({
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
          marketingEmails: true,
          locale: true,
          country: true,
        },
        where: {
          sync: true,
        },
      });

      if (users.length === 0) {
        this.logger.log(color.yellow.bold('No users found to process'));
        return;
      }

      // For users with missing locale, try to fetch from their last payment and update
      for (const user of users) {
        if (!user.locale || user.locale.trim() === '') {
          const lastPayment = await prisma.payment.findFirst({
            where: { userId: user.id, locale: { not: '' } },
            orderBy: { createdAt: 'desc' },
            select: { locale: true },
          });
          if (lastPayment && lastPayment.locale) {
            await prisma.user.update({
              where: { id: user.id },
              data: { locale: lastPayment.locale },
            });
            user.locale = lastPayment.locale;
          }
        }
      }

      // Process each list
      const apiKey = process.env.MAIL_OCTOPUS_API_KEY;
      const processedEmails = new Set<string>();

      for (const [listName, listId] of Object.entries(lists)) {
        if (!listId) {
          const skipDescription =
            listName === 'general'
              ? 'general (all countries)'
              : `${listName} country`;
          this.logger.log(
            color.yellow(
              `Skipping ${white.bold(
                skipDescription
              )} list - no list ID configured`
            )
          );
          continue;
        }

        const listDescription =
          listName === 'general' ? 'general' : `${listName}`;

        this.logger.log(
          color.blue.bold(
            `Processing ${white.bold(listDescription)} list (${white.bold(
              listId
            )})`
          )
        );

        // Filter users based on list type
        let filteredUsers = users;
        if (listName !== 'general') {
          // For country-specific lists, filter by country
          filteredUsers = users.filter((user) => user.country === listName);
        }

        if (filteredUsers.length === 0) {
          this.logger.log(
            color.yellow(
              `No users found for ${white.bold(listDescription)} list`
            )
          );
          continue;
        }

        // Format contacts for Mail Octopus API
        const contacts = filteredUsers.map((user) => ({
          email: user.email,
          fields: {
            FirstName: user.displayName,
            SignupDate: user.createdAt.toISOString(),
            Locale: user.locale || '',
            Country: user.country || '',
          },
          status: user.marketingEmails ? 'subscribed' : 'unsubscribed',
        }));

        // Mail Octopus API v2 endpoint
        const apiUrl = `https://api.emailoctopus.com/lists/${listId}/contacts`;
        let successCount = 0;

        for (const contact of contacts) {
          try {
            await axios.put(
              apiUrl,
              {
                api_key: apiKey,
                email_address: contact.email,
                fields: contact.fields,
                status: contact.status,
                list_id: listId,
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${apiKey}`,
                },
              }
            );

            this.logger.log(
              color.blue.bold(
                `[${white.bold(
                  listDescription
                )}] Successfully uploaded ${white.bold(contact.email)}`
              )
            );

            successCount++;
            processedEmails.add(contact.email);

            // Wait 250ms before the next request to respect rate limiting
            await new Promise((resolve) => setTimeout(resolve, 250));
          } catch (err: any) {
            // Log individual contact errors but continue with others
            this.logger.log(
              color.red(
                `[${white.bold(listDescription)}] Error uploading ${white.bold(
                  contact.email
                )}: ${white.bold(err.message)}`
              )
            );
            console.log(err);

            // Also wait after errors to avoid hitting rate limits
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }

        this.logger.log(
          color.blue.bold(
            `[${white.bold(listDescription)}] Uploaded ${white.bold(
              successCount
            )} out of ${white.bold(contacts.length)} contacts`
          )
        );
      }

      // Set sync to false for all successfully processed users
      if (processedEmails.size > 0) {
        await prisma.user.updateMany({
          where: {
            email: { in: Array.from(processedEmails) },
          },
          data: {
            sync: false,
          },
        });
      }

      this.logger.log(
        color.blue.bold(
          `Contact upload completed. Processed ${white.bold(
            processedEmails.size
          )} unique contacts across all lists`
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

  /**
   * Send a custom email to a customer
   * @param email The customer's email address
   * @param fullname The customer's full name
   * @param subject The email subject (already translated)
   * @param message The email message (already translated)
   * @param locale The target locale
   */
  public async sendCustomMail(
    email: string,
    fullname: string,
    subject: string,
    message: string,
    locale: string = 'en'
  ): Promise<void> {
    if (!this.ses) return;

    const logoPath = `${process.env['ASSETS_DIR']}/images/logo.png`;

    // Convert line breaks to HTML <br> tags for HTML version
    const messageHtml = message.replace(/\n/g, '<br>');

    // Determine greeting based on locale
    const greetings: { [key: string]: string } = {
      en: 'Hello',
      de: 'Hallo',
      fr: 'Bonjour',
      es: 'Hola',
      it: 'Ciao',
      pt: 'Olá',
      pl: 'Cześć',
      sv: 'Hej',
      jp: 'こんにちは',
      cn: '你好',
      ru: 'Здравствуйте',
      hin: 'नमस्ते',
      nl: 'Hallo',
    };

    const mailParams = {
      fullname: fullname || email.split('@')[0],
      greeting: greetings[locale] || 'Hello',
      message: messageHtml,
      messageText: message, // Plain text version with \n preserved
      productName: process.env['PRODUCT_NAME'],
      currentYear: new Date().getFullYear(),
    };

    try {
      // Read the logo file and convert it to Base64
      const logoBuffer = await fs.readFile(logoPath);
      const logoBase64 = this.wrapBase64(logoBuffer.toString('base64'));

      const html = await this.templates.render(
        'mails/custom_email_html',
        mailParams
      );
      const text = await this.templates.render(
        'mails/custom_email_text',
        mailParams
      );

      const attachments: Attachment[] = [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: logoBase64,
          isInline: true,
          cid: 'logo',
        },
      ];

      const rawEmail = await this.renderRaw(
        {
          from: `${process.env['PRODUCT_NAME']} <${process.env['FROM_EMAIL']}>`,
          to: email,
          subject,
          html: html.replace('<img src="logo.png"', '<img src="cid:logo"'),
          text,
          attachments,
          unsubscribe: process.env['UNSUBSCRIBE_EMAIL']!,
          replyTo: process.env['REPLY_TO_EMAIL'],
        },
        true // BCC custom emails
      );

      const emailBuffer = Buffer.from(rawEmail);

      const command = new SendRawEmailCommand({
        RawMessage: {
          Data: emailBuffer,
        },
      });

      await this.ses.send(command);
      this.logger.log(
        color.blue.bold(`Custom email sent to ${white.bold(email)}`)
      );
    } catch (error) {
      console.error('Error while sending custom email:', error);
      this.logger.log(
        color.red.bold(
          `Failed to send custom email to ${white.bold(email)}: ${error}`
        )
      );
    }
  }
}

export default Mail;
