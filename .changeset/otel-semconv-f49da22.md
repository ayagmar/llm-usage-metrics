---
'@ayagmar/agent-sessions': minor
---

The experimental `./otel` helpers follow `semantic-conventions-genai` commit `f49da22`
(`SEMCONV_GENAI_REF.commit`). `usageRecordAttributes` leaves out
`gen_ai.usage.reasoning.output_tokens`, `gen_ai.usage.cache_read.input_tokens` and
`gen_ai.usage.cache_write.input_tokens` when they are zero.
