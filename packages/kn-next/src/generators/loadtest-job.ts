export function generateK6Script(
    targetUrl: string,
    type: "smoke" | "load" | "spike" | "scale-to-zero",
): string {
    let options = "";

    switch (type) {
        case "smoke":
            options = `{
                vus: 1,
                duration: '1m',
            }`;
            break;
        case "load":
            options = `{
                stages: [
                    { duration: '30s', target: 50 },
                    { duration: '2m', target: 50 },
                    { duration: '30s', target: 0 },
                ],
            }`;
            break;
        case "spike":
            options = `{
                stages: [
                    { duration: '10s', target: 10 },
                    { duration: '1m', target: 200 },
                    { duration: '10s', target: 10 },
                ],
            }`;
            break;
        case "scale-to-zero":
            // Small burst to wake it up, wait to scale down, then hit it again
            options = `{
                scenarios: {
                    cold_start: {
                        executor: 'shared-iterations',
                        vus: 10,
                        iterations: 100,
                        maxDuration: '30s',
                    },
                    after_scale_down: {
                        executor: 'shared-iterations',
                        vus: 10,
                        iterations: 100,
                        maxDuration: '30s',
                        startTime: '5m', // Wait 5 mins for scale to zero
                    }
                }
            }`;
            break;
    }

    return `
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = ${options};

export default function () {
    const res = http.get('${targetUrl}');
    check(res, {
        'status was 200': (r) => r.status == 200,
        'transaction time OK': (r) => r.timings.duration < 200,
    });
    sleep(1);
}
`;
}

export function generateLoadTestManifests(
    appName: string,
    namespace: string,
    targetUrl: string,
    type: "smoke" | "load" | "spike" | "scale-to-zero",
    prometheusUrl?: string,
): string[] {
    const scriptContent = generateK6Script(targetUrl, type);
    const runId = Date.now().toString(); // unique ID for this job instance
    const jobName = `k6-${appName}-${type}-${runId}`;

    // ConfigMap to hold the K6 script
    const configMapManifest = `apiVersion: v1
kind: ConfigMap
metadata:
  name: k6-script-${jobName}
  namespace: ${namespace}
data:
  test.js: |
${scriptContent
    .split("\\n")
    .map((line) => `    ${line}`)
    .join("\\n")}
`;

    // Job to execute K6
    let envVars = "";
    if (prometheusUrl) {
        envVars = `
            - name: K6_PROMETHEUS_RW_SERVER_URL
              value: "${prometheusUrl}/api/v1/write"
`;
    }

    const jobManifest = `apiVersion: batch/v1
kind: Job
metadata:
  name: ${jobName}
  namespace: ${namespace}
  labels:
    app: k6-loadtest
    target: ${appName}
spec:
  ttlSecondsAfterFinished: 3600 # Cleanup job an hour after completion
  template:
    metadata:
      labels:
        app: k6-loadtest
        target: ${appName}
    spec:
      containers:
        - name: k6
          image: grafana/k6:latest
          command: ["k6", "run", "/scripts/test.js"]
          args: ["--out", "experimental-prometheus-rw"]
          volumeMounts:
            - name: k6-script
              mountPath: /scripts
          env:
${envVars}
      volumes:
        - name: k6-script
          configMap:
            name: k6-script-${jobName}
      restartPolicy: Never
`;

    return [configMapManifest, jobManifest];
}
