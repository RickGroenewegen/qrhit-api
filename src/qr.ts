import { color } from 'console-log-colors';
import Logger from './logger';
import { PrismaClient } from '@prisma/client';
import Spotify from './spotify';
import Mollie from './mollie';
import Data from './data';
import { v4 as uuid } from 'uuid';

class Qr {
  private prisma = new PrismaClient();
  private spotify = new Spotify();
  private mollie = new Mollie();
  private data = new Data();

  public async generate(params: any): Promise<void> {
    const userProfile = await this.spotify.getUserProfile(params.accessToken);
    const paymentStatus = await this.mollie.checkPaymentStatus(
      params.paymentId
    );
    const userId = paymentStatus.data.user.userId;
    const payment = await this.mollie.getPayment(params.paymentId);

    // Check if the user is the same as the one who made the payment
    if (userProfile.data.userId !== userId) {
      console.log(
        color.red.bold('User is not the same as the one who made the payment')
      );
      return;
    }

    // Retrieve the tracks from Spotify
    const response = await this.spotify.getTracks(
      { authorization: params.accessToken },
      payment.playlist.playlistId
    );

    const tracks = response.data;

    this.data.storeTracks(payment.playlist.id, tracks);
  }
}

export default Qr;
