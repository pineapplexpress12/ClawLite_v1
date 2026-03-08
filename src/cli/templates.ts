import type { Command } from 'commander';

/**
 * Register template listing and detail commands.
 */
export function registerTemplateCommands(program: Command): void {
  program
    .command('templates')
    .description('List all available template graphs')
    .action(async () => {
      // Load built-in templates
      const { getAllTemplates } = await import('../planner/templates.js');
      const templates = getAllTemplates();

      if (templates.length === 0) {
        console.log('No templates found.');
        return;
      }

      console.log('ID                  Trigger          Nodes  Description');
      console.log('-'.repeat(75));
      for (const t of templates) {
        const trigger = t.slashCommand ?? '(freeform)';
        console.log(`${t.id.padEnd(19)} ${trigger.padEnd(16)} ${String(t.nodes.length).padEnd(6)} ${t.description.slice(0, 40)}`);
      }
    });

  program
    .command('template <id>')
    .description('Show template detail')
    .action(async (id: string) => {
      const { getTemplate } = await import('../planner/templates.js');
      const template = getTemplate(id);

      if (!template) {
        console.error(`Template not found: ${id}`);
        process.exit(1);
      }

      console.log(`Template: ${template.name}`);
      console.log(`  ID:          ${template.id}`);
      console.log(`  Description: ${template.description}`);
      console.log(`  Slash cmd:   ${template.slashCommand ?? 'none'}`);

      if (template.slots.length > 0) {
        console.log('\n  Slots:');
        for (const slot of template.slots) {
          const req = slot.required ? '(required)' : '(optional)';
          console.log(`    - ${slot.name} ${req}: ${slot.description}`);
        }
      }

      console.log('\n  Nodes:');
      for (const node of template.nodes) {
        console.log(`    ${node.id.padEnd(20)} ${node.type.padEnd(20)} [${node.model}] → ${node.assignedAgent}`);
      }
    });
}
