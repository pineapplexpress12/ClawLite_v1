#!/usr/bin/env node
import { Command } from 'commander';
import { registerStartCommand } from './daemon.js';
import { registerConfigCommands } from './config.js';
import { registerLogCommands } from './logs.js';
import { registerJobCommands } from './jobs.js';
import { registerBudgetCommand } from './budget.js';
import { registerMemoryCommands } from './memory.js';
import { registerAgentCommands } from './agents.js';
import { registerToolCommands } from './tools.js';
import { registerTemplateCommands } from './templates.js';
import { registerResetCommands } from './reset.js';
import { registerDbCommands } from './db.js';
import { registerSendCommand } from './send.js';
import { registerDryrunCommand } from './dryrun.js';
import { registerSetupCommand } from './setup.js';

const program = new Command();

program
  .name('clawlite')
  .description('ClawLite — Local-first AI operator platform')
  .version('1.0.0');

registerSetupCommand(program);
registerStartCommand(program);
registerConfigCommands(program);
registerLogCommands(program);
registerJobCommands(program);
registerBudgetCommand(program);
registerMemoryCommands(program);
registerAgentCommands(program);
registerToolCommands(program);
registerTemplateCommands(program);
registerResetCommands(program);
registerDbCommands(program);
registerSendCommand(program);
registerDryrunCommand(program);

program.parse();
