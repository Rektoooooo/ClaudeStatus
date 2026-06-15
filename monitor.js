import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const STATUS_URL = 'https://status.claude.com/api/v2/summary.json';
const STATE_FILE = 'state.json';
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const SEED = process.env.SEED === '1';

// Discord embed colors
const COLORS = {
  new: 0xe74c3c, // red — actively broken
  monitoring: 0x3498db, // blue — fix deployed, watching (reassuring, not alarming)
  resolved: 0x2ecc71, // green — all clear
};

// Colored-circle emoji per incident status (matches the embed bar color)
const STATUS_EMOJI = {
  investigating: '🔴',
  identified: '🔴',
  monitoring: '🔵',
  resolved: '🟢',
};

// Severity emoji per impact level
const IMPACT_EMOJI = {
  none: '⚪',
  minor: '🟡',
  major: '🟠',
  critical: '🔴',
};

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { incidents: {} };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function titleCase(str) {
  if (!str) return 'Unknown';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatStatus(status) {
  const labels = {
    investigating: 'Investigating',
    identified: 'Identified',
    monitoring: 'Monitoring',
    resolved: 'Resolved',
  };
  return labels[status] ?? titleCase(status);
}

// Statuspage returns incident_updates newest-first, so [0] is the latest.
function affectedServices(incident) {
  const latest = incident.incident_updates?.[0];
  if (!latest?.affected_components?.length) return null;
  return [...new Set(latest.affected_components.map((c) => c.name))].join(', ');
}

// Build an embed from a live incident object (from the API).
// `statusKey` is the raw status this message is about (e.g. 'investigating',
// 'monitoring', 'resolved'); `statusLabel` is its display form.
function buildEmbed(incident, kind, statusKey, statusLabel) {
  const color =
    kind === 'resolved'
      ? COLORS.resolved
      : incident.status === 'monitoring'
        ? COLORS.monitoring
        : COLORS.new;

  const sEmoji = STATUS_EMOJI[statusKey] ?? '🔴';
  const iEmoji = IMPACT_EMOJI[incident.impact] ?? '⚪';

  // Monitoring means a fix is already in — spell that out so it doesn't read as "still broken".
  const banner =
    statusKey === 'monitoring'
      ? `${sEmoji} MONITORING · FIX DEPLOYED`
      : `${sEmoji} ${statusLabel.toUpperCase()}`;

  const fields = [
    { name: 'Status', value: `${sEmoji} ${statusLabel}`, inline: true },
    { name: 'Impact', value: `${iEmoji} ${titleCase(incident.impact)}`, inline: true },
  ];
  const services = affectedServices(incident);
  if (services) fields.push({ name: 'Affected Services', value: services });

  return {
    author: { name: banner },
    title: incident.name,
    url: incident.shortlink,
    description: incident.incident_updates?.[0]?.body ?? '',
    color,
    fields,
    footer: { text: 'status.claude.com' },
    timestamp: new Date().toISOString(),
  };
}

// Build a resolved embed from saved state (the incident already left the feed).
function buildResolvedEmbedFromState(known) {
  return {
    author: { name: '🟢 RESOLVED' },
    title: known.name,
    url: known.shortlink,
    description: 'This incident has been resolved.',
    color: COLORS.resolved,
    fields: [{ name: 'Status', value: '🟢 Resolved', inline: true }],
    footer: { text: 'status.claude.com' },
    timestamp: new Date().toISOString(),
  };
}

async function sendDiscord(embed, { ping = false } = {}) {
  if (SEED) return; // seeding mode never posts
  const body = {
    username: 'Claude Status',
    embeds: [embed],
  };
  if (ping) {
    body.content = '@everyone';
    body.allowed_mentions = { parse: ['everyone'] };
  }
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}

function record(state, incident, extra = {}) {
  state.incidents[incident.id] = {
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    shortlink: incident.shortlink,
    seenUpdateIds: incident.incident_updates.map((u) => u.id),
    ...extra,
  };
}

async function run() {
  if (!WEBHOOK && !SEED) {
    throw new Error('DISCORD_WEBHOOK_URL is not set');
  }

  const state = loadState();
  let changed = false;

  const res = await fetch(STATUS_URL);
  if (!res.ok) throw new Error(`Status API failed: ${res.status}`);
  const data = await res.json();

  const activeIds = new Set();

  for (const incident of data.incidents) {
    activeIds.add(incident.id);
    const known = state.incidents[incident.id];

    // --- Brand new incident ---
    if (!known) {
      if (incident.status === 'resolved') {
        // Already-resolved on first sight: record silently, don't ping.
        record(state, incident);
      } else {
        await sendDiscord(
          buildEmbed(incident, 'new', incident.status, formatStatus(incident.status)),
          { ping: true },
        );
        record(state, incident);
      }
      changed = true;
      continue;
    }

    // --- New updates on an existing incident ---
    const seenSet = new Set(known.seenUpdateIds);
    for (const update of incident.incident_updates) {
      if (seenSet.has(update.id)) continue;

      if (update.status === 'resolved' && known.status !== 'resolved') {
        await sendDiscord(buildEmbed(incident, 'resolved', 'resolved', 'Resolved'), {
          ping: true,
        });
        known.status = 'resolved';
      } else if (update.status !== 'resolved') {
        await sendDiscord(
          buildEmbed(incident, 'update', update.status, formatStatus(update.status)),
          { ping: true },
        );
      }

      known.seenUpdateIds.push(update.id);
      seenSet.add(update.id);
      changed = true;
    }

    // Keep saved metadata fresh for a possible later "disappeared" resolve.
    known.status = incident.status;
    known.name = incident.name;
    known.impact = incident.impact;
    known.shortlink = incident.shortlink;
  }

  // --- Incidents that vanished from the feed = resolved ---
  for (const [id, known] of Object.entries(state.incidents)) {
    if (!activeIds.has(id) && known.status !== 'resolved') {
      await sendDiscord(buildResolvedEmbedFromState(known), { ping: true });
      known.status = 'resolved';
      changed = true;
    }
  }

  if (changed) {
    saveState(state);
    commitState();
  }

  console.log(SEED ? 'Seed complete.' : 'Done.');
}

function commitState() {
  try {
    execSync('git config user.email "bot@users.noreply.github.com"');
    execSync('git config user.name "claude-status-bot"');
    execSync('git add state.json');
    execSync('git commit -m "chore: update state"');
    execSync('git push');
  } catch {
    // Nothing to commit, or not in a git/CI context — fine for local runs.
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
