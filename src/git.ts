import { CronJob } from 'cron';
import { exec } from 'child_process';
import Utils from './utils';
import cluster from 'cluster';
import Logger from './logger';
import { color } from 'console-log-colors';

class GitChecker {
  private static instance: GitChecker;
  private utils = new Utils();
  private logger = new Logger();

  private constructor() {
    if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
      this.startCronJob();
    }
  }

  public static getInstance(): GitChecker {
    if (!GitChecker.instance) {
      GitChecker.instance = new GitChecker();
    }
    return GitChecker.instance;
  }

  private async startCronJob() {
    const job = new CronJob('*/1 * * * *', async () => {
      await this.checkForChanges();
    });
    job.start();
  }

  private async checkForChanges() {
    exec('git fetch && git status -uno', (error, stdout) => {
      if (error) {
        this.logger.log(
          color.red.bold(
            `Error executing git command: ${color.white.bold(error.message)}`
          )
        );
        return;
      }
      if (stdout.includes('Your branch is behind')) {
        this.logger.log(
          color.blue.bold('There are new changes in the repository.')
        );
        exec('deploy_qrsong', (resetError, resetStdout) => {
          if (resetError) {
            this.logger.log(
              color.red.bold(
                `Error executing reset and pull: ${color.white.bold(
                  resetError.message
                )}`
              )
            );
            return;
          }
          this.logger.log(
            color.green.bold('Repository updated and service restarted!:')
          );
          console.log(resetStdout);
        });
      } else {
        this.logger.log(color.blue.bold('No new changes in the repository.'));
      }
    });
  }
}

export default GitChecker;
