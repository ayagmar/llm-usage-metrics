import { Command } from 'commander';

import { schemaDocuments } from './report-schema-registry.js';

const schemaNames = Object.keys(schemaDocuments).sort();

export function createSchemaCommand(): Command {
  return new Command('schema')
    .description('Print a bundled report JSON Schema')
    .argument('[name]', `Schema name: ${schemaNames.join(', ')}`)
    .option('--list', 'List available schema names')
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
