import configSchema from '../../schema/config.schema.json' with { type: 'json' };
import eventsLineSchema from '../../schema/events-line.v1.schema.json' with { type: 'json' };
import commonSchema from '../../schema/report-common.v1.schema.json' with { type: 'json' };
import compareSchema from '../../schema/report-compare.v1.schema.json' with { type: 'json' };
import doctorSchema from '../../schema/report-doctor.v1.schema.json' with { type: 'json' };
import efficiencySchema from '../../schema/report-efficiency.v1.schema.json' with { type: 'json' };
import optimizeSchema from '../../schema/report-optimize.v1.schema.json' with { type: 'json' };
import pruneSchema from '../../schema/report-prune.v1.schema.json' with { type: 'json' };
import sessionSchema from '../../schema/report-session.v1.schema.json' with { type: 'json' };
import summarySchema from '../../schema/report-summary.v1.schema.json' with { type: 'json' };
import trendsSchema from '../../schema/report-trends.v1.schema.json' with { type: 'json' };
import usageSchema from '../../schema/report-usage.v1.schema.json' with { type: 'json' };
import wrappedSchema from '../../schema/report-wrapped.v1.schema.json' with { type: 'json' };

// Embeds the shared definitions as a JSON Schema 2020-12 bundled resource, so a
// printed schema compiles offline: its absolute report-common $refs resolve to the
// embedded schema's $id.
function bundleCommonDefinitions(schema: { $defs?: Record<string, unknown> }): unknown {
  return { ...schema, $defs: { ...schema.$defs, 'report-common.v1': commonSchema } };
}

// One report name per report-<name>.v1.schema.json file; the schema command
// and the e2e schema validation both derive their names from this record.
export const reportSchemas: Record<string, unknown> = {
  compare: bundleCommonDefinitions(compareSchema),
  doctor: bundleCommonDefinitions(doctorSchema),
  efficiency: bundleCommonDefinitions(efficiencySchema),
  optimize: bundleCommonDefinitions(optimizeSchema),
  prune: bundleCommonDefinitions(pruneSchema),
  session: bundleCommonDefinitions(sessionSchema),
  summary: bundleCommonDefinitions(summarySchema),
  trends: bundleCommonDefinitions(trendsSchema),
  usage: bundleCommonDefinitions(usageSchema),
  wrapped: bundleCommonDefinitions(wrappedSchema),
};

export const schemaDocuments: Record<string, unknown> = {
  ...reportSchemas,
  'events-line': bundleCommonDefinitions(eventsLineSchema),
  config: configSchema,
};
