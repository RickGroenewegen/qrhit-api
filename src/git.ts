import { CronJob } from 'cron';
import { exec } from 'child_process';

class GitChecker {
  private static instance: GitChecker;

  private constructor() {
    this.startCronJob();
  }

  public static getInstance(): GitChecker {
    if (!GitChecker.instance) {
      GitChecker.instance = new GitChecker();
    }
    return GitChecker.instance;
  }

  private startCronJob() {
    const job = new CronJob('*/1 * * * *', () => {
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
      } else {
        console.log('No new changes in the repository.');
      }
    });
  }
}

export default GitChecker;
