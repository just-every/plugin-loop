export function cleanSetting(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function runModelSettings(record) {
  const options = (record && record.options) || {};
  return {
    model: cleanSetting(options.model) || "default",
    reasoning: cleanSetting(options.reasoning_effort || options.reasoningEffort) || "default"
  };
}

export function workerModelSettings(worker, record) {
  const spec = (worker && worker.spec) || {};
  return {
    model: cleanSetting(spec.model) || cleanSetting(worker && worker.model) || runModelSettings(record).model,
    reasoning:
      cleanSetting(spec.reasoning_effort || spec.reasoningEffort) ||
      cleanSetting(worker && (worker.reasoning_effort || worker.reasoningEffort)) ||
      runModelSettings(record).reasoning
  };
}

export function modelSettingsText(settings) {
  const model = settings && settings.model ? settings.model : "default";
  const reasoning = settings && settings.reasoning ? settings.reasoning : "default";
  return `${model} / ${reasoning} reasoning`;
}
