import type { Server } from "bun";
import { ConfigError } from "../settings.ts";
import type { Feature } from "../feature.ts";
import type { Config } from "./config.ts";
import { log } from "./log.ts";
import { createApp } from "./server.ts";
import { SetupCodeError, resolveSetupCode } from "./setup.ts";
import { Store } from "./store.ts";

/** OPDS Proxy: gives e-readers a catalog URL with a token instead of a login, and adapts feeds for them. */
export async function createOpdsProxy(config: Config): Promise<Feature> {
    const store = await Store.open(config.dataDir);

    // OPDS_PROXY_ADMIN_PASSWORD (re)sets the admin password on every start: handy for automation and for recovery
    if (config.adminPassword) {
        const hash = store.config.adminPasswordHash;
        if (!hash || !(await Bun.password.verify(config.adminPassword, hash))) {
            const newHash = await Bun.password.hash(config.adminPassword);
            await store.update((c) => {
                c.adminPasswordHash = newHash;
            });
            log.info("admin password set from OPDS_PROXY_ADMIN_PASSWORD");
        }
    }

    let setup;
    try {
        setup = resolveSetupCode(!!store.config.adminPasswordHash, config.setupCode);
    } catch (err) {
        if (!(err instanceof SetupCodeError)) throw err;
        throw new ConfigError(err.message.replace("SETUP_CODE", "OPDS_PROXY_SETUP_CODE"));
    }
    if (!setup && config.setupCode) log.info("OPDS_PROXY_SETUP_CODE is ignored: the admin account is already set up. You can remove it.");

    const app = createApp({ store, setupCode: setup?.code, setupCodeFromEnv: setup?.source === "env", publicUrl: config.publicUrl,
        upstreamTimeoutMs: config.upstreamTimeoutMs });
    let server: Server<unknown> | undefined;

    return {
        name: "opds-proxy",
        start() {
            server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 120 });
            void app.checkAll();
            const adminUrl = config.publicUrl ? `${config.publicUrl}/admin` : `/admin on port ${server.port} (e.g. http://<docker-host>:${server.port}/admin)`;
            log.info(`listening on port ${server.port}`);
            if (setup?.source === "env") log.info(`first start: open ${adminUrl} and enter the OPDS_PROXY_SETUP_CODE from your environment`);
            else if (setup) log.info(`first start: open ${adminUrl} and enter the setup code  ${setup.code}`);
            else log.info(`admin UI: ${adminUrl}`);
        },
        // Nothing runs in the background
        once: async () => true,
        async stop() {
            await server?.stop();
            await store.flush();
        },
    };
}
