import Server from './server';
import dotenv from 'dotenv';

dotenv.config();

const server = Server.getInstance();

server.init();
