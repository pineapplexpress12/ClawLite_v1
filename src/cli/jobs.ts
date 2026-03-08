import type { Command } from 'commander';

/**
 * Register job listing and detail commands.
 */
export function registerJobCommands(program: Command): void {
  program
    .command('jobs')
    .description('List recent jobs')
    .option('--status <status>', 'Filter by status (running, completed, failed)')
    .option('-n, --limit <count>', 'Number of jobs to show', '20')
    .action(async (options) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getRecentJobs, getJobsByStatus } = await import('../db/jobs.js');

      let jobs;
      if (options.status) {
        jobs = getJobsByStatus([options.status]);
      } else {
        jobs = getRecentJobs(parseInt(options.limit, 10));
      }

      if (jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }

      console.log('ID        Status     Type       Trigger    Cost     Goal');
      console.log('-'.repeat(70));
      for (const job of jobs) {
        const id = job.id.slice(0, 8);
        console.log(`${id}  ${job.status.padEnd(10)} ${job.job_type.padEnd(10)} ${job.trigger_type.padEnd(10)} ${String(job.budget_tokens).padEnd(8)} ${job.goal.slice(0, 40)}`);
      }
    });

  program
    .command('job <id>')
    .description('Show job detail')
    .action(async (id: string) => {
      const { loadConfig } = await import('../core/config.js');
      const { initDb } = await import('../db/connection.js');
      loadConfig();
      initDb();

      const { getJob } = await import('../db/jobs.js');
      const { getNodesByJobId } = await import('../db/nodes.js');

      const job = getJob(id);
      if (!job) {
        console.error(`Job not found: ${id}`);
        process.exit(1);
      }

      console.log(`Job ${job.id}`);
      console.log(`  Goal:      ${job.goal}`);
      console.log(`  Status:    ${job.status}`);
      console.log(`  Type:      ${job.job_type}`);
      console.log(`  Trigger:   ${job.trigger_type}`);
      console.log(`  Budget:    ${job.budget_tokens} tokens`);
      console.log(`  LLM calls: ${job.total_llm_calls}`);
      console.log(`  Retries:   ${job.total_retries}`);
      console.log(`  Created:   ${new Date(job.created_at).toISOString()}`);

      const nodes = getNodesByJobId(job.id);
      if (nodes.length > 0) {
        console.log('\n  Nodes:');
        for (const node of nodes) {
          const icon = node.status === 'completed' ? '\u2705' : node.status === 'running' ? '\u2699\ufe0f' : '\u23f3';
          console.log(`    ${icon} ${node.type.padEnd(20)} [${node.model}] ${node.status}`);
        }
      }
    });
}
