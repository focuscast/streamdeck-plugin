import streamDeck, {
  action,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  PropertyInspectorDidAppearEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FOCUSCAST_TIMEOUT_MS = 5000;

type ToggleSettings = {
  scene?: string;
  app?: string;
  focuscastPath?: string;
};

type MappingInfo = {
  scene: string;
  app_name: string;
  source_name: string;
  active: boolean;
};

type ListMappingsResponse = {
  type: "listMappingsResult";
  ok: boolean;
  mappings?: MappingInfo[];
  error?: string;
};

type ListMappingsRequest = {
  type?: string;
  focuscastPath?: string;
  settings?: ToggleSettings;
};

const extraPathEntries = (() => {
  const home = homedir();

  if (process.platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.cargo/bin`];
  }

  if (process.platform === "win32") {
    return [`${home}\\.cargo\\bin`];
  }

  return ["/usr/local/bin", "/usr/bin", `${home}/.cargo/bin`];
})();

function buildFocuscastEnv(): NodeJS.ProcessEnv {
  const currentPath = process.env.PATH || "";
  const allEntries = [...currentPath.split(delimiter), ...extraPathEntries];
  const deduped = [...new Set(allEntries.filter(Boolean))];

  return {
    ...process.env,
    PATH: deduped.join(delimiter),
  };
}

function normalizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown error";
  }

  const errorWithCode = error as Error & { code?: string; stderr?: string };
  if (errorWithCode.code === "ENOENT") {
    return "Focuscast CLI not found. Set Focuscast Path (for Homebrew: /opt/homebrew/bin/focuscast).";
  }

  const stderr = errorWithCode.stderr?.trim();
  return stderr || error.message;
}

function normalizeSettings(input: ToggleSettings | undefined): ToggleSettings {
  const normalize = (value?: string): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  return {
    scene: normalize(input?.scene),
    app: normalize(input?.app),
    focuscastPath: normalize(input?.focuscastPath),
  };
}

async function runFocuscastJson<T>(
  args: string[],
  focuscastPath?: string,
): Promise<T> {
  const binary = focuscastPath?.trim() || "focuscast";
  try {
    const { stdout } = await execFileAsync(binary, args, {
      env: buildFocuscastEnv(),
      timeout: FOCUSCAST_TIMEOUT_MS,
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (error) {
    throw new Error(normalizeError(error));
  }
}

function formatTitle(settings: ToggleSettings, active?: boolean): string {
  if (!settings.scene || !settings.app) {
    return "Select\nMapping";
  }

  const line1 = settings.app;
  if (typeof active === "boolean") {
    return `${line1}\n${active ? "Enabled" : "Disabled"}`;
  }
  return `${line1}\nUnknown`;
}

async function setButtonState(
  actionInstance: {
    setTitle: (title: string) => Promise<void>;
    setState?: (state: number) => Promise<void>;
  },
  settings: ToggleSettings,
  active?: boolean,
): Promise<void> {
  await actionInstance.setTitle(formatTitle(settings, active));
  if (actionInstance.setState) {
    await actionInstance.setState(active ? 1 : 0);
  }
}

async function sendToPropertyInspector(
  actionInstance: unknown,
  payload: ListMappingsResponse,
): Promise<void> {
  const maybeAction = actionInstance as {
    sendToPropertyInspector?: (data: object) => Promise<void>;
  };
  if (maybeAction.sendToPropertyInspector) {
    await maybeAction.sendToPropertyInspector(payload);
    return;
  }
  await streamDeck.ui.sendToPropertyInspector(payload);
}

async function resolveFocuscastPath(
  actionInstance: unknown,
): Promise<string | undefined> {
  const maybeAction = actionInstance as {
    getSettings?: () => Promise<ToggleSettings>;
  };
  if (!maybeAction.getSettings) {
    return undefined;
  }
  try {
    const settings = await maybeAction.getSettings();
    return settings.focuscastPath;
  } catch {
    return undefined;
  }
}

async function resolveSettings(
  actionInstance: unknown,
  fallback: ToggleSettings,
): Promise<ToggleSettings> {
  const maybeAction = actionInstance as {
    getSettings?: () => Promise<ToggleSettings>;
  };

  if (!maybeAction.getSettings) {
    return fallback;
  }

  try {
    const stored = await maybeAction.getSettings();
    return normalizeSettings({ ...fallback, ...stored });
  } catch {
    return normalizeSettings(fallback);
  }
}

@action({ UUID: "live.focuscast.streamdeck.toggle" })
export class Toggle extends SingletonAction<ToggleSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ToggleSettings>,
  ): Promise<void> {
    const settings = normalizeSettings(ev.payload.settings);
    if (!settings.scene || !settings.app) {
      await setButtonState(ev.action, settings);
      return;
    }
    await this.refreshMappingState(ev, settings);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ToggleSettings>,
  ): Promise<void> {
    await this.refreshMappingState(ev, normalizeSettings(ev.payload.settings));
  }

  override async onPropertyInspectorDidAppear(
    ev: PropertyInspectorDidAppearEvent<ToggleSettings>,
  ): Promise<void> {
    await this.sendMappingsToInspector(ev.action);
  }

  override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
    const settings = await resolveSettings(ev.action, ev.payload.settings);
    if (!settings.scene || !settings.app) {
      await ev.action.showAlert();
      await setButtonState(ev.action, settings);
      return;
    }

    try {
      const mapping = await runFocuscastJson<MappingInfo>(
        [
          "mappings",
          "toggle",
          "--scene",
          settings.scene,
          "--app",
          settings.app,
          "--format",
          "json",
        ],
        settings.focuscastPath,
      );
      await setButtonState(ev.action, settings, mapping.active);
      await ev.action.showOk();
    } catch (error) {
      streamDeck.logger.error("Failed to toggle mapping", error);
      await ev.action.showAlert();
      await ev.action.setTitle("Error");
    }
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<ListMappingsRequest, ToggleSettings>,
  ): Promise<void> {
    if (ev.payload?.type === "listMappings") {
      await this.sendMappingsToInspector(ev.action, ev.payload.focuscastPath);
      return;
    }

    if (ev.payload?.type !== "updateSettings") {
      return;
    }

    const settings = normalizeSettings(ev.payload.settings);
    await ev.action.setSettings(settings);
    await this.refreshMappingStateForAction(ev.action, settings);
  }

  private async refreshMappingState(
    ev:
      | WillAppearEvent<ToggleSettings>
      | DidReceiveSettingsEvent<ToggleSettings>,
    settings: ToggleSettings,
  ): Promise<void> {
    await this.refreshMappingStateForAction(ev.action, settings);
  }

  private async refreshMappingStateForAction(
    actionInstance: {
      setTitle: (title: string) => Promise<void>;
      setState?: (state: number) => Promise<void>;
    },
    settings: ToggleSettings,
  ): Promise<void> {
    if (!settings.scene || !settings.app) {
      await setButtonState(actionInstance, settings);
      return;
    }

    try {
      const mapping = await runFocuscastJson<MappingInfo>(
        [
          "mappings",
          "get",
          "--scene",
          settings.scene,
          "--app",
          settings.app,
          "--format",
          "json",
        ],
        settings.focuscastPath,
      );
      await setButtonState(actionInstance, settings, mapping.active);
    } catch (error) {
      streamDeck.logger.error("Failed to load mapping state", error);
      await actionInstance.setTitle("Error");
    }
  }

  private async sendMappingsToInspector(
    actionInstance: unknown,
    focuscastPathOverride?: string,
  ): Promise<void> {
    try {
      const focuscastPath =
        focuscastPathOverride || (await resolveFocuscastPath(actionInstance));
      const mappings = await runFocuscastJson<MappingInfo[]>(
        ["mappings", "list", "--format", "json"],
        focuscastPath,
      );
      await sendToPropertyInspector(actionInstance, {
        type: "listMappingsResult",
        ok: true,
        mappings,
      } satisfies ListMappingsResponse);
    } catch (error) {
      streamDeck.logger.error("Failed to list mappings", error);
      await sendToPropertyInspector(actionInstance, {
        type: "listMappingsResult",
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to load mappings from focuscast",
      } satisfies ListMappingsResponse);
    }
  }
}
