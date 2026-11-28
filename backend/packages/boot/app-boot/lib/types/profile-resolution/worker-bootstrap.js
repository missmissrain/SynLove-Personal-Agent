/** Install an inherited profile resolution generation in one Harness-owned Worker. */
import { getEnvironmentData } from 'node:worker_threads';
import { installProfileResolution } from "./resolver.js";
const registration = getEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution');
if (registration !== undefined)
    installProfileResolution(registration.generation, registration.behavior);
//# sourceMappingURL=worker-bootstrap.js.map