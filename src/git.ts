import { CronJob } from 'cron';
import { exec } from 'child_process';
import Utils from './utils';
import cluster from 'cluster';

class GitChecker {
  private static instance: GitChecker;
  private utils = new Utils();

  private constructor() {
    if (cluster.isPrimary) {
      this.startCronJob();
    }
  }

  public static getInstance(): GitChecker {
    if (!GitChecker.instance) {
      GitChecker.instance = new GitChecker();
    }
    return GitChecker.instance;
  }

  private startCronJob() {
    const job = new CronJob('*/10 * * * * *', () => {
      this.checkForChanges();
    });
    job.start();
  }

  private checkForChanges() {
    exec('git fetch && git status -uno', (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing git command: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`Git stderr: ${stderr}`);
        return;
      }
      if (stdout.includes('Your branch is behind')) {
        console.log('There are new changes in the repository.');
        exec('git reset --hard HEAD && git pull origin HEAD && pm2 restart qrsong', (resetError, resetStdout, resetStderr) => {
          if (resetError) {
            console.error(`Error executing reset and pull: ${resetError.message}`);
            return;
          }
          if (resetStderr) {
            console.error(`Reset and pull stderr: ${resetStderr}`);
            return;
          }
          console.log('Repository updated and service restarted:', resetStdout);
        });
      } else {
        console.log('No new changes in the repository.');
      }
    });
  }
}

export default GitChecker;
