import Server from './server';
import dotenv from 'dotenv';

// Loaded by app.ts once the cluster workers are forked. Everything heavy is
// imported from here, never from app.ts.

dotenv.config({ quiet: true });

(BigInt.prototype as any).toJSON = function () {
  const int = Number.parseInt(this.toString());
  return int ?? this.toString();
};

const server = Server.getInstance();

server.init();
