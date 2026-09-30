/**
 * `blockingmachine tier-plan` — which static tiers are worth keeping on.
 *
 * The extension popup answers this against the browser's *live* static-rule grant, which is the
 * only number that accounts for how congested the shared pool is. That number does not exist
 * outside a browser, and it is the number that decides the outcome: a plan is trivial at the
 * guaranteed 30,000 and contested well below it. So the question was unanswerable at exactly the
 * two moments it matters most — deciding what to ship from the hub, and reviewing on the command
 * line what is already on disk.
 *
 * What this command adds is the part that is answerable anywhere: the tier sizes read from the
 * actual files, and a `--capacity` figure so a reviewer can ask "what if the pool only grants
 * this?". Given a rule-hit ledger it weights the plan by what actually blocked, through the same
 * `planTierBenefits` the popup uses, and says which basis it landed on.
 *
 * The arithmetic — reading the ledger, matching lines to tiers, validating, planning — is
 * `computeTierPlan` in core, shared with the desktop hub so the two cannot report different plans
 * for the same files. What is left here is reading bytes off disk and printing them.
 */

import {
  BaseCommand,
  type CommandOptions,
  type CommandResult,
} from "./BaseCommand.js";
import {
  STATIC_RULE_TIERS,
  computeTierPlan,
  formatTierPlan,
  manifestRuleResources,
  parseEnabledTierIds,
  type TierFileInput,
  type TierPlanComputation,
} from "@blockingmachine/core";
import fs from "fs/promises";
import path from "path";
import chalk from "chalk";

export interface TierPlanOptions {
  /** Directory holding `tier_*.json`, i.e. the extension's `rules/`. */
  rulesDir?: string;
  /** A rule-hit ledger, as the extension exports it. */
  hits?: string;
  /** Static slots to plan against. Defaults to Chrome's guaranteed floor. */
  capacity?: number;
  /** Tiers to treat as currently on. Defaults to the manifest's enabled flags. */
  enabled?: string;
  json?: boolean;
}

/** The tiers the manifest enables on a fresh install, used when `--enabled` is absent. */
function manifestDefaults() {
  return manifestRuleResources()
    .filter((entry) => entry.enabled)
    .map((entry) => entry.id);
}

/** Parses each catalogue tier's file. A file that cannot be read is carried as an error, not thrown. */
async function readTierFiles(rulesDir: string): Promise<TierFileInput[]> {
  return Promise.all(
    STATIC_RULE_TIERS.map(async (tier): Promise<TierFileInput> => {
      const file = path.join(rulesDir, path.basename(tier.path));
      try {
        return { id: tier.id, rules: JSON.parse(await fs.readFile(file, "utf8")) };
      } catch (error) {
        return {
          id: tier.id,
          rules: null,
          readError: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
}

export class TierPlanCommand extends BaseCommand {
  constructor(options: CommandOptions) {
    super(options);
  }

  async execute(options: TierPlanOptions = {}): Promise<CommandResult> {
    try {
      const rulesDir = options.rulesDir ?? "rules";
      const files = await readTierFiles(rulesDir);
      const ledgerText = options.hits ? await fs.readFile(options.hits, "utf8") : null;
      const enabled = parseEnabledTierIds(options.enabled, manifestDefaults());

      const result: TierPlanComputation = computeTierPlan({
        files,
        ledger: ledgerText === null ? null : { text: ledgerText },
        enabled,
        capacity: options.capacity,
      });

      if (result.broken.length > 0) {
        return this.failure(
          `${result.broken.length} tier file${result.broken.length === 1 ? '' : 's'} failed ` +
            `validation, so there is nothing to plan:\n${result.broken
              .map((row) => `  ${row.label}: ${row.errors.slice(0, 3).join('; ')}`)
              .join('\n')}`,
        );
      }

      const data = {
        rulesDir,
        capacity: result.capacitySlots,
        files: result.rows.map(({ id, label, rules, hits }) => ({ id, label, rules, hits })),
        enabled,
        capacitySummary: result.capacity,
        plan: {
          enabled: result.plan.enabled,
          disabled: result.plan.disabled,
          enabledRules: result.plan.enabledRules,
          totalRules: result.plan.totalRules,
          staticHeadroom: result.plan.staticHeadroom,
          bindingConstraint: result.plan.bindingConstraint,
          benefit: result.plan.benefit,
          benefitSource: result.plan.benefitSource,
          explanation: result.plan.explanation,
        },
        basis: result.basis
          ? { source: result.basis.source, reason: result.basis.reason, unmeasured: result.basis.unmeasured }
          : null,
        ledger: result.ledger,
      };

      if (options.json) {
        this.logger.info(JSON.stringify(data, null, 2));
        return this.success(data, "Tier plan computed");
      }

      const { ledger, basis, plan, capacitySlots } = result;

      this.logger.info("");
      this.logger.info(chalk.bold("Static tier capacity plan"));
      this.logger.info(`  rules      ${rulesDir}`);
      for (const row of result.rows) {
        const state = enabled.includes(row.id) ? chalk.green('on') : chalk.dim('off');
        const measured = row.hits === null ? '' : chalk.dim(`  ${row.hits.toLocaleString()} measured`);
        this.logger.info(
          `  ${row.label.padEnd(20)} ${row.rules.toLocaleString().padStart(8)} rules  ${state}${measured}`,
        );
      }

      // Headroom is reported against the capacity actually planned for, not against Chrome's
      // guaranteed floor. Printing the floor's headroom next to a congested figure would read as
      // "40 slots, 29,976 free", which is the kind of sentence nobody should have to parse twice.
      const activeRules = result.capacity.enabledRules;
      this.logger.info(
        `  capacity   ${capacitySlots.toLocaleString()} slots planned · ` +
          `${activeRules.toLocaleString()} active of ${result.capacity.totalRules.toLocaleString()} shipped · ` +
          `${Math.max(0, capacitySlots - activeRules).toLocaleString()} free`,
      );

      if (ledger) {
        this.logger.info(
          `  ledger     ${ledger.lines.toLocaleString()} measured lines ` +
            `(${ledger.skipped.toLocaleString()} named no blockable host)` +
            (ledger.shared > 0
              ? `, ${ledger.shared.toLocaleString()} matched a host more than one tier ships`
              : ''),
        );
      }

      this.logger.info("");
      // `formatTierPlan` is the one-liner the popup shows, rather than a line lifted out of the
      // explanation — which would print the same sentence twice on the same screen.
      this.logger.info(chalk.bold(`  ${formatTierPlan(plan)}`));
      if (basis) {
        this.logger.info(
          basis.source === 'evidence'
            ? chalk.green(`  ${basis.reason}`)
            : chalk.dim(`  ${basis.reason}`),
        );
      } else {
        this.logger.info(
          chalk.dim(
            '  No ledger given, so the plan is ranked by rule count (--hits <ledger> to weight it by what blocked).',
          ),
        );
      }
      for (const line of plan.explanation) this.logger.info(chalk.dim(`  ${line}`));
      this.logger.info("");

      return this.success(data, "Tier plan computed");
    } catch (error) {
      return this.handleError(error);
    }
  }
}
