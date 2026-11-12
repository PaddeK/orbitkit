import type { Server } from "bun";
import { every, type Feature } from "../feature.ts";
import { Login } from "../login.ts";
import { Checker } from "./check.ts";
import type { Config } from "./config.ts";
import { Epublift } from "./epublift.ts";
import { log } from "./log.ts";
import { Replacer } from "./replace.ts";
import { page, serveReports } from "./report.ts";
import { epubsanaVersion } from "./repairer.ts";
import { State } from "./state.ts";
import { epubveriVersion } from "./validator.ts";

/** Who may see the report pages, which show the library and can change it */
const PERMISSION = { key: "manage_libraries", label: "Manage libraries" };

/** EPUB Check: validates every EPUB in BookOrbit and serves report pages with fixes. */
export async function createEpubCheck(config: Config): Promise<Feature> {
    const state = await State.open(config.dataDir);
    let epublift: Epublift | undefined;
    if (config.epublift) {
        epublift = (await Epublift.find(config.epubliftPath, `${config.dataDir}/tmp`)) ?? undefined;
        if (!epublift) log.error(`EPUB_CHECK_EPUBLIFT is on, but "${config.epubliftPath}" cannot be run (EPUB_CHECK_EPUBLIFT_PATH); upgrades are not offered`);
    }
    const checker = new Checker(config, state, epublift);
    const login = config.requireLogin
        ? await Login.open({
            bookorbitUrl: config.bookorbitUrl,
            bookorbitPublicUrl: config.bookorbitPublicUrl,
            file: `${config.dataDir}/sessions.json`,
            cookie: "orbitkit_epub_check",
            permission: PERMISSION.key,
            permissionLabel: PERMISSION.label,
            title: "orbitkit EPUB Check",
            basePath: config.basePath,
            log,
            page,
        })
        : undefined;
    let server: Server<unknown> | undefined;
    let loop: { stop(): void } | undefined;

    return {
        name: "epub-check",
        start() {
            log.info(`epubveri ${epubveriVersion}, epubsana ${epubsanaVersion}${epublift ? `, epublift ${epublift.version}` : ""}; checking every ${config.checkInterval}s`
                + `${config.dryRun ? " (dry run: nothing is changed in BookOrbit)" : ""}`);
            void checker.bookorbit.checkAuth().then(
                (user) => log.info(`BookOrbit: logged in as ${user}${config.bookorbitApiKey ? " with an API key" : ""}`),
                (err) => log.error(`BookOrbit: ${(err as Error).message}`));
            // Replacing books needs the dry run off: it changes the library, which a dry run promises not to
            const replacer = config.replaceInLibrary && !config.dryRun ? new Replacer(config, state, checker) : undefined;
            server = serveReports(config, state, checker, replacer, login);
            log.info(`reports on port ${config.port}${config.basePath ? ` and below ${config.basePath}` : ""}`
                + `${login ? ` (BookOrbit login with "${PERMISSION.label}" required)` : " (no login required: EPUB_CHECK_REQUIRE_LOGIN is off)"}`
                + `${config.reportUrl ? `, linked in BookOrbit as ${config.reportUrl}` : " (set EPUB_CHECK_REPORT_URL to link them in BookOrbit)"}`
                + `${replacer ? "; books can be replaced in the library" : ""}`);
            loop = every(config.checkInterval, log, () => checker.cycle());
        },
        async once() {
            try {
                await checker.cycle();
                return true;
            } catch (err) {
                log.error(`cycle failed: ${(err as Error).message}`);
                return false;
            }
        },
        async stop() {
            loop?.stop();
            await server?.stop();
            await state.save();
        },
    };
}
