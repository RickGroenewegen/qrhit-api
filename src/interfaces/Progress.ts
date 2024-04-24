import { SocketStream } from '@fastify/websocket';

export interface Progress {
  paymentId: string;
  progress: number;
  message: string;
}
