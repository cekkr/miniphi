import { greet, farewell } from "./greeter.js";
import { average, describeTrend } from "./math.js";

export function summarize(values, name) {
  const intro = greet(name);
  const avg = average(values);
  const trend = describeTrend(values);
  return `${intro} The average of ${values.length} samples is ${avg}, trend looks ${trend}.`;
}

export function closingRemark(name) {
  return farewell(name);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const sampleValues = [1, 3, 5, 7];
  console.log(summarize(sampleValues, "MiniPhi"));
  console.log(closingRemark("MiniPhi"));
}
