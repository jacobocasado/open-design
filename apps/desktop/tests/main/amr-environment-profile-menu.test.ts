import { describe, expect, it } from "vitest";

import {
  createAmrEnvironmentProfileMenuItems,
  mergeAmrEnvironmentProfileConfig,
  normalizeAmrEnvironmentProfile,
} from "../../src/main/index.js";

describe("AMR Environment Profile desktop menu helpers", () => {
  it("normalizes missing or invalid profile values to prod", () => {
    expect(normalizeAmrEnvironmentProfile(undefined)).toBe("prod");
    expect(normalizeAmrEnvironmentProfile("")).toBe("prod");
    expect(normalizeAmrEnvironmentProfile("staging")).toBe("prod");
    expect(normalizeAmrEnvironmentProfile("local")).toBe("local");
    expect(normalizeAmrEnvironmentProfile("test")).toBe("test");
    expect(normalizeAmrEnvironmentProfile("prod")).toBe("prod");
  });

  it("merges the selected profile without deleting other app config env", () => {
    const result = mergeAmrEnvironmentProfileConfig(
      {
        agentId: "claude",
        agentCliEnv: {
          amr: {
            VELA_BIN: "/opt/open-design/vela",
            VELA_LINK_URL: "https://amr.example.test/link",
            OPEN_DESIGN_AMR_PROFILE: "prod",
          },
          claude: {
            ANTHROPIC_BASE_URL: "https://claude.example.test",
          },
        },
        customInstructions: "Keep failures visible.",
      },
      "local",
    );

    expect(result).toEqual({
      agentId: "claude",
      agentCliEnv: {
        amr: {
          VELA_BIN: "/opt/open-design/vela",
          VELA_LINK_URL: "https://amr.example.test/link",
          OPEN_DESIGN_AMR_PROFILE: "local",
        },
        claude: {
          ANTHROPIC_BASE_URL: "https://claude.example.test",
        },
      },
      customInstructions: "Keep failures visible.",
    });
  });

  it("creates the AMR env section when the existing config has no agentCliEnv", () => {
    expect(mergeAmrEnvironmentProfileConfig({}, "test")).toEqual({
      agentCliEnv: {
        amr: {
          OPEN_DESIGN_AMR_PROFILE: "test",
        },
      },
    });
  });

  it("builds radio menu items for prod, test, and local", () => {
    const selected: string[] = [];
    const [profileMenu] = createAmrEnvironmentProfileMenuItems("test", (profile) => {
      selected.push(profile);
    });

    expect(profileMenu.label).toBe("AMR Profile");
    expect(profileMenu.submenu).toEqual([
      expect.objectContaining({ label: "prod", type: "radio", checked: false }),
      expect.objectContaining({ label: "test", type: "radio", checked: true }),
      expect.objectContaining({ label: "local", type: "radio", checked: false }),
    ]);

    const localItem = Array.isArray(profileMenu.submenu)
      ? profileMenu.submenu.find((item) => item.label === "local")
      : null;
    localItem?.click?.(undefined as never, undefined as never, undefined as never);
    expect(selected).toEqual(["local"]);
  });
});
