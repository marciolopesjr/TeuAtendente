import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("license");

export type LicenseStatus = {
  isValid: boolean;
  plan: "free" | "pro" | "enterprise";
  message?: string;
};

export function validateLicense(key?: string): LicenseStatus {
  if (!key) {
    return {
      isValid: true,
      plan: "free",
      message: "No license key provided. Running in Free mode.",
    };
  }

  // Simple mock validation for now.
  // In a real product, this would verify a signature or call a licensing server.
  if (key.startsWith("PRO-")) {
    return {
      isValid: true,
      plan: "pro",
      message: "Pro license verified.",
    };
  }

  if (key.startsWith("ENT-")) {
    return {
      isValid: true,
      plan: "enterprise",
      message: "Enterprise license verified.",
    };
  }

  return {
    isValid: false,
    plan: "free",
    message: "Invalid license key. Falling back to Free mode.",
  };
}

export function logLicenseStatus(status: LicenseStatus) {
  if (status.isValid) {
    if (status.plan === "free") {
        log.info(`License Status: Free Mode. ${status.message || ""}`);
    } else {
        log.info(`License Status: ${status.plan.toUpperCase()} Mode. ${status.message || ""}`);
    }
  } else {
    log.warn(`License Status: Invalid. ${status.message || ""}`);
  }
}
