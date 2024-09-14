import Server from './server';
import dotenv from 'dotenv';
import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

dotenv.config();

if (process.env['ENVIRONMENT'] === 'development') {
  Sentry.init({
    dsn: 'https://fbb350c809685382751c422a65a9766f@o1181344.ingest.us.sentry.io/4507950233223168',
    integrations: [nodeProfilingIntegration()],
    // Tracing
    tracesSampleRate: 1.0, //  Capture 100% of the transactions

    // Set sampling rate for profiling - this is relative to tracesSampleRate
    profilesSampleRate: 1.0,
  });
}

const server = Server.getInstance();

server.init();
