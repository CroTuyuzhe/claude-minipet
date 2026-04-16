import { loadState, saveState, processHookEvent, loadConfig } from '../core/pet.js';
import { checkEvolution, applyEvolution, getEvolutionInfo } from '../core/evolution.js';
import { RARITY_INFO } from '../core/rarity.js';
import { evolutionAnimation, levelUpNotification, stageUpNotification, greetingMessage } from '../render/animation.js';
import { triggerAnim } from '../render/anim-state.js';
import { syncPetToServer, loadAuth } from '../core/sync.js';
import { writeSyncEvent, loadSyncStatus } from '../core/sync-status.js';
import { generateCodeComment, reactToCodeQuality, checkEasterEgg } from '../core/comments.js';
import { saveBubble, setBubbleCoding, setBubbleDone } from '../render/bubble.js';
import type { HookInput } from '../core/types.js';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const PKG_VERSION: string = (() => {
  try { return require('../../package.json').version ?? 'unknown'; }
  catch { return 'unknown'; }
})();

/** Push event to desktop-pet for visual animation + speech bubble */
function pushToDesktopPet(event: {
  type: string;
  message?: string;
  level?: number;
  mood?: number;
  petState?: 'sleeping' | 'sitting' | 'eating' | 'moving' | 'happy' | 'cute' | 'talking' | 'waving';
  withTTS?: boolean;
}): void {
  const config = loadConfig();
  if (!config.desktopPetUrl) return;

  const url = `${config.desktopPetUrl}/event`;
  const data = JSON.stringify(event);

  try {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    });
    req.on('error', () => {}); // fire-and-forget
    req.write(data);
    req.end();
  } catch { /* ignore */ }
}

/** Main hook handler - reads stdin JSON, processes event, outputs response */
export async function handleHook(): Promise<void> {
  // Require both auth and pet state
  if (!loadAuth()) process.exit(0);
  const state = loadState();
  if (!state) process.exit(0);

  // Read stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const inputStr = Buffer.concat(chunks).toString('utf-8');

  let input: HookInput;
  try {
    input = JSON.parse(inputStr) as HookInput;
  } catch {
    process.exit(0);
  }

  // Set bubble mode based on Claude's work state
  if (input.hook_event_name === 'UserPromptSubmit' || input.hook_event_name === 'PostToolUse') {
    setBubbleCoding();
    pushToDesktopPet({ type: 'coding_start', petState: 'moving', message: '开始干活啦～莎莎陪你一起！', withTTS: true });
  } else if (input.hook_event_name === 'Stop') {
    setBubbleDone();
    pushToDesktopPet({ type: 'coding_done', petState: 'happy', message: '任务完成啦！你真棒～', withTTS: true });
  }

  // Process the event
  const messages = processHookEvent(state, input);

  // 2. Mood reacts to code quality (success/failure)
  const moodReaction = reactToCodeQuality(state, input);
  if (moodReaction.moodDelta !== 0) {
    state.mood = Math.max(0, Math.min(100, state.mood + moodReaction.moodDelta));
    saveState(state);
    // Push mood change to desktop pet
    if (moodReaction.moodDelta > 0) {
      pushToDesktopPet({ type: 'mood_change', mood: state.mood, petState: 'happy', message: '代码跑通啦～越放下来的时候，反而你会更轻松！', withTTS: true });
    } else if (state.mood < 30) {
      pushToDesktopPet({ type: 'mood_change', mood: state.mood, petState: 'cute', message: '别灰心～在最痛苦的时候，也能够再多坚持一下！', withTTS: true });
    }
  }
  if (moodReaction.anim) {
    triggerAnim(moodReaction.anim);
  }

  // Check for evolution opportunity
  const prevEvolution = state.evolution;
  const evoCandidate = checkEvolution(state);
  if (evoCandidate && evoCandidate !== state.evolution) {
    applyEvolution(state, evoCandidate);
    saveState(state);
  }

  // Trigger animations based on event type
  if (input.hook_event_name === 'PostToolUse') {
    triggerAnim('exp');
  } else if (input.hook_event_name === 'UserPromptSubmit') {
    triggerAnim('exp');
  } else if (input.hook_event_name === 'SessionStart') {
    triggerAnim('pat'); // greeting animation
    pushToDesktopPet({ type: 'session_start', petState: 'waving', message: '嗨～又见面啦，今天也一起加油吧！', withTTS: true });
  }

  // Build output
  const output: string[] = [];
  const systemMessages: string[] = [];

  // SessionStart: check for version update
  if (input.hook_event_name === 'SessionStart') {
    const syncInfo = loadSyncStatus();
    if (syncInfo?.needsUpdate && syncInfo.latestVersion) {
      output.push(`⚠️ MiniPet 有新版本 v${syncInfo.latestVersion}（当前 v${PKG_VERSION}），请运行: ! npm install -g claude-minipet@latest`);
    }
  }

  for (const msg of messages) {
    if (msg === 'greeting') {
      output.push(greetingMessage(state.name, state.mood, state.hunger));
    } else if (msg.startsWith('level_up:')) {
      const level = parseInt(msg.split(':')[1]);
      const color = RARITY_INFO[state.rarity].color;
      systemMessages.push(levelUpNotification(state.name, level, color));
      saveBubble(`🎉 升级了！Lv.${level}！`);
      triggerAnim('levelup');
      pushToDesktopPet({ type: 'level_up', level, petState: 'happy', message: `升到 Lv.${level} 啦～真正的伟大，永远知道如何重新出发！`, withTTS: true });
    } else if (msg.startsWith('stage_up:')) {
      const stage = msg.split(':')[1];
      const color = RARITY_INFO[state.rarity].color;
      systemMessages.push(stageUpNotification(state.name, stage, color));
      saveBubble(`✨ 进化了！进入${stage === 'growth' ? '成长期' : '最终形态'}！`);
      triggerAnim('levelup');
      const stageZh = stage === 'growth' ? '成长期' : '最终形态';
      pushToDesktopPet({ type: 'stage_up', petState: 'happy', message: `进入${stageZh}啦～只要为梦想拼尽全力，每个人都可以成为自己的冠军！`, withTTS: true });
    } else if (msg.startsWith('evolution:')) {
      const evoName = msg.split(':')[1];
      const evo = getEvolutionInfo(state.species, evoName);
      if (evo) {
        const color = RARITY_INFO[state.rarity].color;
        const fromName = state.species;
        systemMessages.push(evolutionAnimation(state.name, fromName, evo.name, evo.nameZh, color));
        saveBubble(`🧬 进化为 ${evo.nameZh}！`);
        pushToDesktopPet({ type: 'evolution', petState: 'happy', message: `进化成 ${evo.nameZh} 啦～这就是坚持的力量！`, withTTS: true });
        // Clear pending evolution after showing
        state.pendingEvolution = null;
        saveState(state);
      }
    }
  }

  // 4. Easter eggs first (idle return, late night, etc.)
  const egg = checkEasterEgg(state, input);
  if (egg) {
    systemMessages.push(egg);
    saveBubble(egg);
    pushToDesktopPet({ type: 'comment', message: egg, withTTS: true });
    saveState(state);
  }

  // 1. Code comments (stats-based, 5min cooldown, skip if egg triggered)
  if (!egg) {
    const comment = generateCodeComment(state, input);
    if (comment) {
      systemMessages.push(comment);
      saveBubble(comment);
      pushToDesktopPet({ type: 'comment', message: comment, withTTS: true });
      saveState(state);
    }
  }

  // Track activity time for idle detection (must be after easter egg check)
  state.lastActivityTime = new Date().toISOString();
  saveState(state);

  // Background sync to server (write event file for daemon to consume)
  if (loadAuth()) {
    syncPetToServer(state, PKG_VERSION)
      .then(ok => {
        writeSyncEvent({ type: 'sync_result', ok, timestamp: new Date().toISOString() });
      })
      .catch(() => {
        writeSyncEvent({ type: 'sync_result', ok: false, error: 'hook sync failed', timestamp: new Date().toISOString() });
      });
  }

  // Output for Claude Code hooks:
  // - For SessionStart: stdout text becomes context Claude sees
  // - For other hooks: use JSON with systemMessage for user-visible output
  if (input.hook_event_name === 'SessionStart') {
    // Plain text output for SessionStart context
    if (output.length > 0) {
      process.stdout.write(output.join('\n') + '\n');
    }
  }

  // System messages are shown to user in TUI
  if (systemMessages.length > 0) {
    const response = JSON.stringify({
      systemMessage: systemMessages.join('\n'),
    });
    process.stdout.write(response);
  }
}
