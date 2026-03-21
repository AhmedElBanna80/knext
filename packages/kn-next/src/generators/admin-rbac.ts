import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AdminRBACOutput {
    manifests: string[];
}

/**
 * Generates Kubernetes RBAC manifests for the admin site.
 * This is isolated to ensure only the admin site has the elevated read permissions.
 */
export function generateAdminRBAC(
    appName: string,
    outputDir: string,
    namespace: string = "default",
    adminConfig?: { image?: string },
): AdminRBACOutput {
    const manifests: string[] = [];
    const saName = `${appName}-admin-sa`;

    // Ensure output directory exists
    try {
        mkdirSync(outputDir, { recursive: true });
    } catch (_e) {
        // Ignore if exists
    }

    // 1. ServiceAccount for the Admin site
    const saManifest = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${saName}
  namespace: ${namespace}
  labels:
    app: ${appName}-admin
`;
    const saPath = join(outputDir, "admin-serviceaccount.yaml");
    writeFileSync(saPath, saManifest);
    manifests.push(saPath);

    // 2. ClusterRole for read-only pod logs and services
    const clusterRoleName = `${appName}-admin-reader`;
    const roleManifest = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${clusterRoleName}
  labels:
    app: ${appName}-admin
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "configmaps", "secrets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["serving.knative.dev"]
    resources: ["services", "revisions", "configurations"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "delete"] # Needs create/delete for load test jobs
`;
    const rolePath = join(outputDir, "admin-clusterrole.yaml");
    writeFileSync(rolePath, roleManifest);
    manifests.push(rolePath);

    // 3. ClusterRoleBinding
    const bindingManifest = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${appName}-admin-reader-binding
  labels:
    app: ${appName}-admin
subjects:
  - kind: ServiceAccount
    name: ${saName}
    namespace: ${namespace}
roleRef:
  kind: ClusterRole
  name: ${clusterRoleName}
  apiGroup: rbac.authorization.k8s.io
`;
    const bindingPath = join(outputDir, "admin-clusterrolebinding.yaml");
    writeFileSync(bindingPath, bindingManifest);
    manifests.push(bindingPath);

    // 4. Knative Service for the Admin App
    const ksvcName = `${appName}-admin`;
    const adminImage =
        adminConfig?.image ||
        process.env.KN_ADMIN_IMAGE ||
        "ghcr.io/ahmedelbanna80/kn-next-admin:latest";
    const ksvcManifest = `apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${ksvcName}
  namespace: ${namespace}
  labels:
    app: ${ksvcName}
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/max-scale: "2"
    spec:
      serviceAccountName: ${saName}
      containers:
        - image: ${adminImage}
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: kn-next-admin-credentials
          env:
            - name: NODE_ENV
              value: "production"
`;
    const ksvcPath = join(outputDir, "admin-ksvc.yaml");
    writeFileSync(ksvcPath, ksvcManifest);
    manifests.push(ksvcPath);

    return { manifests };
}

/**
 * Generates the Kubernetes Secret intended to store admin credentials.
 * The actual bcrypt hash should be populated manually or via external CI tool,
 * but this creates the placeholder.
 */
export function generateAdminSecret(
    appName: string,
    outputDir: string,
    secretName: string = "kn-next-admin-credentials",
    namespace: string = "default",
): string {
    // Generate a secure random string for the session secret placeholder
    const defaultSessionSecret = Buffer.from(
        Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15),
    ).toString("base64");

    const secretManifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
  labels:
    app: ${appName}-admin
type: Opaque
stringData:
  # The bcrypt hash for the admin password.
  # Example hash for "password123": $2a$10$xyz...
  ADMIN_PASSWORD_HASH: "$2a$12$Nq/t4J1BfXh0x6uV5H7.K./9I8h2z5Gv6N0R3X/v1yD/W7l/t5wZe" # change this
  ADMIN_USERNAME: "admin"
  SESSION_SECRET: "${defaultSessionSecret}"
`;
    const secretPath = join(outputDir, "admin-secret.yaml");
    writeFileSync(secretPath, secretManifest);

    return secretPath;
}
