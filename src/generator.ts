import { color, blue, white } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import Utils from './utils';
import Mollie from './mollie';
import crypto from 'crypto';
import sanitizeFilename from 'sanitize-filename';
import * as fs from 'fs/promises';
import Data from './data';
import PushoverClient from './pushover';
import Spotify from './spotify';
import Mail from './mail';
import QR from './qr';
import PDF from './pdf';
import Order from './order';

class Generator {
  private logger = new Logger();
  private utils = new Utils();
  private prisma = PrismaInstance.getInstance();
  private data = new Data();
  private pushover = new PushoverClient();
  private spotify = new Spotify();
  private mail = new Mail();
  private qr = new QR();
  private pdf = new PDF();
  private order = Order.getInstance();

  public async generate(
    paymentId: string,
    ip: string,
    refreshPlaylists: string,
    mollie: Mollie
  ): Promise<void> {
    this.logger.log(
      blue.bold(`Starting generation for payment: ${white.bold(paymentId)}`)
    );

    let orderType = 'digital';

    const refreshPlaylistArray = refreshPlaylists.split(',');

    const paymentStatus = await mollie.checkPaymentStatus(paymentId);
    const userId = paymentStatus.data.payment.user.userId;
    let payment = await mollie.getPayment(paymentId);

    const user = await this.data.getUserByUserId(userId);

    // Check if the user is the same as the one who made the payment
    if (user.userId !== userId) {
      this.logger.log(
        color.red.bold('User is not the same as the one who made the payment')
      );
      return;
    }

    if (!paymentStatus.success) {
      this.logger.log(color.red.bold('Payment failed!'));
      return;
    }

    // Get all playlists associated with the payment
    const playlists = await this.data.getPlaylistsByPaymentId(paymentId);

    // If any of the playlists is not digital, we need to create a physical order
    for (const playlist of playlists) {
      if (playlist.orderType !== 'digital') {
        orderType = 'physical';
        break;
      }
    }

    const physicalPlaylists = [];

    // Send the main mail
    await this.mail.sendEmail('main_' + orderType, payment, playlists);

    for (const playlist of playlists) {
      const { filename, filenameDigital } = await this.generatePDF(
        payment,
        playlist,
        ip,
        refreshPlaylistArray.includes(playlist.playlistId)
      );

      if (playlist.orderType !== 'digital') {
        physicalPlaylists.push({ playlist, filename });
      }

      // Find the PaymentHasPlaylist entry to get the unique id
      const paymentHasPlaylist = await this.prisma.paymentHasPlaylist.findUnique({
        where: {
          paymentId_playlistId: {
            paymentId: payment.id,
            playlistId: playlist.id,
          },
        },
      });

      if (paymentHasPlaylist) {
        // Update the paymentHasPlaylist with the filenames
        await this.prisma.paymentHasPlaylist.update({
          where: {
            id: paymentHasPlaylist.id,
          },
          data: {
            filename,
            filenameDigital,
          },
        });
      }

      // Call sendEmail to notify the user
      await this.mail.sendEmail(
        'digital',
        payment,
        [playlist],
        filename,
        filenameDigital
      );
    }

    let printApiOrderId = '';
    let printApiOrderRequest = '';
    let printApiOrderResponse = '';

    if (physicalPlaylists.length > 0) {
      payment.printerPageCount = await this.utils.countPdfPages(
        `${process.env['PUBLIC_DIR']}/pdf/${physicalPlaylists[0].filename}`
      );
      const orderData = await this.order.createOrder(
        payment,
        physicalPlaylists
      );
      printApiOrderId = orderData.response.id;
      printApiOrderRequest = JSON.stringify(orderData.request);
      printApiOrderResponse = JSON.stringify(orderData.response);
    }

    // Update the payment with the order id
    await this.prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: {
        printApiOrderId,
        printApiOrderRequest,
        printApiOrderResponse,
      },
    });

    let orderName = `${payment.fullname} (${payment.countrycode})`;

    let totalNumberOfTracks = 0;
    // Loop through the playlists and update the total number of tracks
    for (const playlist of playlists) {
      totalNumberOfTracks += playlist.numberOfTracks;
    }

    // Pushover
    this.pushover.sendMessage(
      {
        title: `KA-CHING! € ${payment.profit
          .toString()
          .replace('.', ',')} verdiend!`,
        message: `${orderName} heeft ${
          payment.PaymentHasPlaylist.length
        } set(s) met in totaal ${totalNumberOfTracks} kaarten besteld voor totaal € ${payment.totalPrice
          .toString()
          .replace('.', ',')}.`,
        sound: 'incoming',
      },
      ip
    );

    this.logger.log(
      color.green.bold(
        `Order processed successfully for payment: ${white.bold(paymentId)}`
      )
    );
  }

  private async generatePDF(
    payment: any,
    playlist: any,
    ip: string,
    refreshCache: boolean = false
  ): Promise<{ filename: string; filenameDigital: string }> {
    let filename = '';
    let filenameDigital = '';

    this.logger.log(
      blue.bold(`Generating PDF for playlist: ${white.bold(playlist.name)}`)
    );

    const hash = crypto
      .createHmac('sha256', process.env['PLAYLIST_SECRET']!)
      .update(playlist.playlistId)
      .digest('hex');

    filename = sanitizeFilename(
      `${hash}_printer.pdf`.replace(/ /g, '_')
    ).toLowerCase();
    filenameDigital = sanitizeFilename(
      `${hash}_digital.pdf`.replace(/ /g, '_')
    ).toLowerCase();

    let exists = false;
    if (playlist.orderType === 'digital') {
      const digitalPath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;
      try {
        await fs.access(digitalPath);
        exists = true;
        this.logger.log(
          color.yellow.bold(
            `Digital PDF already exists: ${color.white.bold(filenameDigital)}`
          )
        );
      } catch (error) {
        // Digital file doesn't exist
      }
    } else {
      const normalPath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
      const digitalPath = `${process.env['PUBLIC_DIR']}/pdf/${filenameDigital}`;
      try {
        await Promise.all([fs.access(normalPath), fs.access(digitalPath)]);
        exists = true;
        this.logger.log(
          color.yellow.bold(
            `Both PDFs already exist: ${color.white.bold(
              filename
            )} and ${color.white.bold(filenameDigital)}`
          )
        );
      } catch (error) {
        // At least one of the files doesn't exist
      }
    }

    this.logger.log(
      blue.bold(
        `Retrieving tracks for playlist: ${white.bold(playlist.playlistId)}`
      )
    );

    if (refreshCache) {
      exists = false;
      this.logger.log(
        color.yellow.bold(
          `User has refreshed the playlist cache for playlist: ${white.bold(
            playlist.playlistId
          )} so we are regenerating the PDFs`
        )
      );
    }

    if (!exists) {
      // Retrieve the tracks from Spotify
      const response = await this.spotify.getTracks(playlist.playlistId);
      const tracks = response.data;

      // If there are more than 500 remove the last tracks
      if (tracks.length > 500) {
        tracks.splice(500);
      }

      this.logger.log(
        blue.bold(
          `Storing ${white.bold(
            tracks.length
          )} tracks for playlist: ${white.bold(playlist.playlistId)}`
        )
      );
      await this.data.storeTracks(playlist.id, tracks);

      this.logger.log(
        blue.bold(
          `Retrieving ${white.bold(
            tracks.length
          )} tracks for playlist: ${white.bold(playlist.playlistId)}`
        )
      );
      const dbTracks = await this.data.getTracks(playlist.id);
      playlist.numberOfTracks = dbTracks.length;

      this.logger.log(
        blue.bold(
          `Creating QR codes for ${white.bold(
            tracks.length
          )} tracks for playlist: ${white.bold(playlist.playlistId)}`
        )
      );

      // Loop through the tracks and create a QR code for each track
      for (const track of dbTracks) {
        const link = `${process.env['API_URI']}/qr/${track.id}`;

        // Get the first 3 characters of the track id
        const startChars = track.trackId.substring(0, 4);
        const outputDir = `${process.env['PUBLIC_DIR']}/qr/${startChars}`;
        const outputPath = `${outputDir}/${track.trackId}.png`;
        await this.utils.createDir(outputDir);
        await this.qr.generateQR(link, outputPath);

        // Create a progress based on 70-90% of the total tracks
        const progress = Math.floor(
          (tracks.indexOf(track) / tracks.length) * 20 + 70
        );
      }

      this.logger.log(
        blue.bold(
          `Creating PDF tracks for playlist: ${white.bold(playlist.playlistId)}`
        )
      );

      const [generatedFilenameDigital, generatedFilename] = await Promise.all([
        this.pdf.generatePDF(
          filenameDigital,
          playlist,
          payment,
          'digital',
          80,
          89
        ),
        playlist.orderType != 'digital'
          ? this.pdf.generatePDF(filename, playlist, payment, 'printer', 90, 99)
          : Promise.resolve(''),
      ]);

      filename = generatedFilename;
      filenameDigital = generatedFilenameDigital;
    }

    return { filename, filenameDigital };
  }
}

export default Generator;
