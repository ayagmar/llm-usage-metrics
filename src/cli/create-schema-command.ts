import { Command } from 'commander';

import { formatHelpExamples } from './report-definitions/report-definitions.js';
import { schemaDocuments } from './report-schema-registry.js';

export const schemaNames = Object.keys(schemaDocuments).sort();

export function createSchemaCommand(): Command {
  return new Command('schema')
    .description('Print a bundled report JSON Schema')
    .argument('[name]', `Schema name: ${schemaNames.join(', ')}`)
    .option('--list', 'List available schema names')
    .addHelpText(
      'after',
      formatHelpExamples([
        'llm-usage schema --list',
        'llm-usage schema summary > summary.schema.json',
      ]),
    )
    .action((name: string | undefined, options: { list?: boolean }) => {
      if (options.list) {
        for (const schemaName of schemaNames) {
          console.log(schemaName);
        }

        return;
      }

      const schema = name === undefined ? undefined : schemaDocuments[name];

      if (schema === undefined) {
        throw new Error(
          `Unknown schema "${name ?? ''}"; valid names: ${schemaNames.join(', ')} (or --list)`,
        );
      }

      console.log(JSON.stringify(schema, null, 2));
    });
}
