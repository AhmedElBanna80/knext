import path from 'node:path';
import fs from 'fs-extra';
import type { RouteGroup } from './splitter';

export class Generator {
  private outputDir: string;
  private imageName: string;
  private namespace: string;
  private envConfig: Record<string, string>;
  private projectRoot: string;

  constructor(
    outputDir: string,
    imageName: string,
    namespace = 'default',
    envConfig: Record<string, string> = {},
    projectRoot = '.',
  ) {
    this.outputDir = outputDir;
    this.imageName = imageName;
    this.namespace = namespace;
    this.projectRoot = projectRoot;
    this.envConfig = {
      CERBOS_URL: 'cerbos.default.svc.cluster.local:3593',
      MINIO_ENDPOINT: 'minio.default.svc.cluster.local',
      MINIO_PORT: '9000',
      MINIO_USE_SSL: 'false',
      // Prefer explicitly provided envConfig (or environment variables) for sensitive values.
      DATABASE_URL: '',
      MINIO_ACCESS_KEY: '',
      MINIO_SECRET_KEY: '',
      ...envConfig,
    };
  }

  async generate(groups: RouteGroup[], groupImages: Record<string, string>) {
    await fs.ensureDir(this.outputDir);

    // 1. Generate Knative Services
    for (const group of groups) {
      const explicitImageName = groupImages[group.name];
      if (!explicitImageName) {
        console.warn(
          `Generator: No image specified for route group "${group.name}" in groupImages; falling back to default image "${this.imageName}".`,
        );
      }
      const effectiveImageName = explicitImageName || this.imageName;
      const serviceYaml = this.generateServiceYaml(group, effectiveImageName);
      await fs.writeFile(path.join(this.outputDir, `service-${group.name}.yaml`), serviceYaml);
    }

    // 2. Generate VirtualService (Routing)
    const vsYaml = this.generateVirtualServiceYaml(groups);
    await fs.writeFile(path.join(this.outputDir, 'virtual-service.yaml'), vsYaml);
  }

  private generateServiceYaml(group: RouteGroup, imageName: string): string {
    const envVars = Object.entries(this.envConfig)
      .filter(([, value]) => value !== '')
      .map(
        ([key, value]) => `            - name: ${key}
              value: "${value}"`,
      )
      .join('\n');

    return `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: next-${group.name}
  namespace: ${this.namespace}
  annotations:
    serving.knative.dev/digestResolution: "skipped"
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
        # Fluid Compute emulation: Allow high concurrency per instance
        autoscaling.knative.dev/target: "100"
        # Skip digest resolution for local images
        serving.knative.dev/digestResolution: "skipped"
    spec:
      containers:
        - image: ${imageName}
          imagePullPolicy: Never
          env:
            - name: NEXT_HANDLER_PATH
              value: "${group.paths[0]}" # Hint to runtime which page to optimize for (optional)
            - name: NEXT_PROJECT_ROOT
              value: "${this.projectRoot}"
${envVars}
          ports:
            - containerPort: 3000
`;
  }

  private generateVirtualServiceYaml(groups: RouteGroup[]): string {
    const routes = groups
      .map((group) => {
        // Simple path matching. For regex/dynamic routes, Istio supports regex.
        // Next.js regex needs to be converted to Istio regex if complex.
        // For now, we use exact match for static and prefix/regex for dynamic.

        const matchers = group.paths
          .map((p) => {
            if (p.includes('[')) {
              // Convert Next.js dynamic route /blog/[slug] to regex /blog/[^/]+
              // Handle catch-all [...slug] -> .*
              let regex = p;

              // Handle catch-all [...param]
              regex = regex.replace(/\/\[\.\.\..*?\]/g, '/.*');

              // Handle single param [param]
              regex = regex.replace(/\/\[.*?\]/g, '/[^/]+');

              // Ensure start anchor, and if it doesn't end with .*, ensure end anchor (or handle subpaths?)
              // Next.js routes are exact matches unless catch-all.
              // But /blog/[slug] should match /blog/foo but NOT /blog/foo/bar

              regex = `^${regex}$`;

              return `    - uri:
        regex: "${regex}"`;
            }
            return `    - uri:
        exact: "${p}"`;
          })
          .join('\n');

        return `
  - match:
${matchers}
    rewrite:
      authority: next-${group.name}.${this.namespace}.svc.cluster.local
    route:
    - destination:
        host: next-${group.name}.${this.namespace}.svc.cluster.local
`;
      })
      .join('\n');

    return `
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: next-app-router
  namespace: ${this.namespace}
spec:
  hosts:
  - "*"
  gateways:
  - knative-serving/knative-ingress-gateway # Assuming standard Knative setup
  http:
${routes}
`;
  }
}
