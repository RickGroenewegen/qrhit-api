import dotenv from 'dotenv';
import { startClusterWorkers } from './clusterPrimary';

dotenv.config({ quiet: true });

// Entry point of every process, primary and worker alike. Loading the
// application takes a second or more per process, so the primary forks its
// workers first and only then loads the application itself; in a worker the
// fork step is a no-op. That is why bootstrap.ts is imported dynamically and
// why nothing else may be imported here: see clusterPrimary.ts.
startClusterWorkers().then(() => import('./bootstrap'));
