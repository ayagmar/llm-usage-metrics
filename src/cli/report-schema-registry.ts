import configSchema from '../../schema/config.schema.json' with { type: 'json' };
import eventsLineSchema from '../../schema/events-line.v1.schema.json' with { type: 'json' };
import compareSchema from '../../schema/report-compare.v1.schema.json' with { type: 'json' };
import doctorSchema from '../../schema/report-doctor.v1.schema.json' with { type: 'json' };
import efficiencySchema from '../../schema/report-efficiency.v1.schema.json' with { type: 'json' };
import optimizeSchema from '../../schema/report-optimize.v1.schema.json' with { type: 'json' };
import pruneSchema from '../../schema/report-prune.v1.schema.json' with { type: 'json' };
import sessionSchema from '../../schema/report-session.v1.schema.json' with { type: 'json' };
import trendsSchema from '../../schema/report-trends.v1.schema.json' with { type: 'json' };
import usageSchema from '../../schema/report-usage.v1.schema.json' with { type: 'json' };
import wrappedSchema from '../../schema/report-wrapped.v1.schema.json' with { type: 'json' };

// One report name per report-<name>.v1.schema.json file; the schema command
// and the e2e schema validation both derive their names from this record.
export const reportSchemas: Record<string, unknown> = {
  compare: compareSchema,
  doctor: doctorSchema,
  efficiency: efficiencySchema,
  optimize: optimizeSchema,
  prune: pruneSchema,
  session: sessionSchema,
  trends: trendsSchema,
  usage: usageSchema,
  wrapped: wrappedSchema,
};

export const schemaDocuments: Record<string, unknown> = {
  ...reportSchemas,
  'events-line': eventsLineSchema,
  config: configSchema,
};
