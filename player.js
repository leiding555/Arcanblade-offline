"use strict";

const element = id => document.getElementById(id);
const views = ["pairing", "library", "work", "offline", "player"];
const audio = element("audio");
const connection = element("connection");
const playbackStatus = element("playback-status");
const subtitles = element("subtitles");
const subtitleScroll = element("subtitle-scroll");
const subtitleCues = element("subtitle-cues");
const resumeSubtitles = element("resume-subtitles");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const hosted = document.documentElement.dataset.offlineOnly === "true";
const inWechat = /MicroMessenger/i.test(navigator.userAgent);
const standaloneMode = window.matchMedia("(display-mode: standalone)");
const isStandalone = () => standaloneMode.matches || navigator.standalone === true;
const isAppleMobile = () => /iPhone|iPad|iPod|Macintosh.*Mobile/i.test(navigator.userAgent);
const installButton = element("install-app");
const installHelp = element("install-help");
let installPrompt = null;
let appInstalled = false;
let work = null;
let tracks = [];
let trackIndex = -1;
let cueRows = [];
let cueEvents = [];
let nextCueEvent = 0;
let activeCues = new Set();
let followingSubtitles = true;
let viewGeneration = 0;
let trackGeneration = 0;
let frame = 0;
let subtitleStatus = "";
let subtitleRequest = null;
let offlineReady = false;
let playingOffline = false;
let audioObjectUrl = "";
let coverObjectUrl = "";
let importing = null;
let offlineWorkId = null;
let offlineCoverUrls = [];
const packageForm = element("package-form");

function view(id) {
  for (const name of views) element(name).hidden = name !== id;
  document.body.classList.toggle("player-open", id === "player");
  element("tracks-button").hidden = id !== "player";
  element("library-button").hidden = hosted || id === "library" || id === "pairing" || inWechat;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "请求失败。");
    error.status = response.status;
    throw error;
  }
  return result;
}

function message(error) {
  return error instanceof TypeError || error instanceof SyntaxError
    ? "无法连接电脑，请确认手机播放仍开启且两台设备在同一网络。"
    : error.message;
}

function stopTrack() {
  ++trackGeneration;
  subtitleRequest?.abort();
  subtitleRequest = null;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
  if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
  audioObjectUrl = "";
  coverObjectUrl = "";
  playingOffline = false;
  cancelAnimationFrame(frame);
  frame = 0;
  cueRows = [];
  cueEvents = [];
  nextCueEvent = 0;
  activeCues.clear();
  followingSubtitles = true;
  subtitleCues.replaceChildren();
  subtitleScroll.scrollTo({ top: 0, behavior: "instant" });
  subtitles.hidden = true;
  resumeSubtitles.hidden = true;
  subtitleStatus = "";
  playbackStatus.textContent = "";
}

function showPairing(error) {
  ++viewGeneration;
  stopTrack();
  view("pairing");
  connection.textContent = error ? message(error) : "";
}

async function showWorks(initial = false) {
  const generation = ++viewGeneration;
  stopTrack();
  if (!initial) view("library");
  connection.textContent = "正在读取作品库…";
  try {
    const result = await request("/api/works");
    if (generation !== viewGeneration) return;
    const grid = element("works");
    grid.replaceChildren();
    for (const item of result.works) {
      const card = document.createElement("button");
      card.className = "work-card";
      const image = document.createElement("img");
      image.src = `/api/works/${item.id}/cover`;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => { image.src = "/mark.png"; }, { once: true });
      card.append(image, document.createTextNode(item.name));
      card.addEventListener("click", () => showWork(item));
      grid.append(card);
    }
    connection.textContent = result.works.length ? "" : "作品库为空。";
    view("library");
  } catch (error) {
    if (generation !== viewGeneration) return;
    showPairing(error.status === 401 && initial ? null : error);
  }
}

async function showWork(item) {
  const generation = ++viewGeneration;
  stopTrack();
  work = item;
  element("work-name").textContent = item.name;
  const list = element("tracks");
  list.replaceChildren();
  packageForm.hidden = true;
  element("package-open").hidden = true;
  element("package-help").hidden = true;
  element("hosted-library").hidden = true;
  connection.textContent = "正在读取音轨…";
  view("work");
  try {
    const result = await request(`/api/works/${item.id}/tracks`);
    if (generation !== viewGeneration) return;
    work = { id: item.id, name: result.name };
    tracks = result.tracks;
    element("package-open").hidden = !tracks.some(track => track.size > 0);
    element("work-name").textContent = result.name;
    for (const [index, track] of tracks.entries()) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.textContent = track.name;
      if (track.directory && track.directory !== ".") {
        const directory = document.createElement("small");
        directory.textContent = track.directory;
        button.append(directory);
      }
      button.addEventListener("click", () => playTrack(index));
      row.append(button);
      list.append(row);
    }
    connection.textContent = tracks.length ? "" : "此作品没有可播放的 MP3 或 WAV 音轨。";
  } catch (error) {
    if (generation !== viewGeneration) return;
    if (error.status === 401) showPairing(error);
    else connection.textContent = message(error);
  }
}

function updatePackageSelection() {
  const enabled = [...element("package-tracks").querySelectorAll("input")];
  const chosen = enabled.filter(input => input.checked);
  const total = chosen.reduce((sum, input) => sum + Number(input.dataset.size), 0);
  const all = element("package-all");
  all.checked = chosen.length === enabled.length;
  all.indeterminate = chosen.length > 0 && !all.checked;
  element("package-selection").value = chosen.map(input => input.value).join(",");
  element("package-size").textContent = `已选 ${chosen.length} 条 · 约 ${fileSize(total)}`;
  element("package-submit").disabled = chosen.length === 0 || chosen.length > 4096;
  if (chosen.length > 4096) element("package-size").textContent += " · 一次最多 4096 条";
}

function openPackageSelection() {
  if (!work) return;
  const list = element("package-tracks");
  list.replaceChildren();
  for (const track of tracks) {
    if (!Number.isSafeInteger(track.size) || track.size <= 0) continue;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = track.id;
    input.dataset.size = track.size;
    input.checked = true;
    const text = track.directory && track.directory !== "." ? `${track.directory} / ${track.name}` : track.name;
    label.append(input, text);
    list.append(label);
  }
  packageForm.action = `/api/works/${work.id}/offline-package`;
  packageForm.hidden = false;
  updatePackageSelection();
}

function cueTimestamp(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const tail = String(seconds % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${tail}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
}

function installSubtitles(entries) {
  const rows = document.createDocumentFragment();
  cueRows = [...entries].sort(([a], [b]) => a - b).map(([start, end, text], index) => {
    if (end > start) {
      cueEvents.push({ time: start / 1000, index, starts: true }, { time: end / 1000, index, starts: false });
    }
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "subtitle-cue";
    button.dataset.cue = index;
    const timeLabel = document.createElement("span");
    timeLabel.className = "cue-time";
    timeLabel.textContent = cueTimestamp(start);
    const cueText = document.createElement("span");
    cueText.className = "cue-text";
    cueText.textContent = text;
    button.append(timeLabel, cueText);
    item.append(button);
    rows.append(item);
    return { start, button };
  });
  cueEvents.sort((a, b) => a.time - b.time);
  subtitleCues.replaceChildren(rows);
  subtitles.hidden = !cueRows.length;
  renderSubtitles();
}

function latestActiveCue(cues) {
  let latest = -1;
  for (const index of cues) latest = Math.max(latest, index);
  return latest;
}

function followCue(index) {
  if (index < 0 || subtitles.hidden) return;
  const row = cueRows[index].button.getBoundingClientRect();
  const viewport = subtitleScroll.getBoundingClientRect();
  const top = viewport.top + subtitleScroll.clientTop;
  const height = subtitleScroll.clientHeight;
  const upper = top + height * .2;
  const lower = top + height * .8;
  const rowFits = row.height <= lower - upper;
  if (row.top >= upper && (rowFits ? row.bottom <= lower : row.top < lower)) return;

  const target = Math.max(0, Math.min(subtitleScroll.scrollTop + row.top - top - height * .3,
    subtitleScroll.scrollHeight - height));
  if (Math.abs(target - subtitleScroll.scrollTop) < 1) return;
  subtitleScroll.scrollTo({ top: target, behavior: reducedMotion.matches ? "instant" : "smooth" });
}

function renderSubtitles() {
  const time = audio.currentTime;
  if (!Number.isFinite(time)) return;
  // Only update highlights when playback crosses a cue boundary, in either direction.
  if (!(nextCueEvent < cueEvents.length && cueEvents[nextCueEvent].time <= time)
      && !(nextCueEvent > 0 && cueEvents[nextCueEvent - 1].time > time)) return;

  const previousCue = latestActiveCue(activeCues);
  const nextActive = new Set(activeCues);
  while (nextCueEvent < cueEvents.length && cueEvents[nextCueEvent].time <= time) {
    const { index, starts } = cueEvents[nextCueEvent++];
    if (starts) nextActive.add(index);
    else nextActive.delete(index);
  }
  while (nextCueEvent > 0 && cueEvents[nextCueEvent - 1].time > time) {
    const { index, starts } = cueEvents[--nextCueEvent];
    if (starts) nextActive.delete(index);
    else nextActive.add(index);
  }
  for (const index of activeCues) {
    if (!nextActive.has(index)) cueRows[index].button.classList.remove("is-active");
  }
  for (const index of nextActive) {
    if (!activeCues.has(index)) cueRows[index].button.classList.add("is-active");
  }
  activeCues = nextActive;
  const currentCue = latestActiveCue(activeCues);
  if (currentCue === previousCue) return;
  if (previousCue >= 0) cueRows[previousCue].button.removeAttribute("aria-current");
  if (currentCue >= 0) cueRows[currentCue].button.setAttribute("aria-current", "true");
  if (followingSubtitles) followCue(currentCue);
}

function pauseSubtitleFollowing() {
  if (!followingSubtitles || subtitles.hidden) return;
  followingSubtitles = false;
  subtitleScroll.scrollTo({ top: subtitleScroll.scrollTop, behavior: "instant" });
  resumeSubtitles.hidden = false;
}

function tick() {
  renderSubtitles();
  frame = audio.paused || audio.ended ? 0 : requestAnimationFrame(tick);
}

function playTrack(index) {
  if (!work || index < 0 || index >= tracks.length) return;
  stopTrack();
  const generation = trackGeneration;
  const track = tracks[index];
  trackIndex = index;
  connection.textContent = "";
  element("playing-work").textContent = work.name;
  element("playing-track").textContent = track.name;
  element("cover").src = `/api/works/${work.id}/cover`;
  element("previous").disabled = index === 0;
  element("next").disabled = index === tracks.length - 1;
  view("player");

  const path = `/api/works/${work.id}/tracks/${track.id}`;
  audio.src = path + "/audio";
  audio.play().catch(error => {
    if (generation === trackGeneration && error.name === "NotAllowedError") {
      playbackStatus.textContent = "请点击播放器的播放按钮。";
    }
  });
  subtitleRequest = new AbortController();
  request(path + "/subtitles", { signal: subtitleRequest.signal }).then(result => {
    if (generation !== trackGeneration) return;
    installSubtitles(result.entries);
    subtitleStatus = subtitleMessage(result.state);
    if (!audio.error) playbackStatus.textContent = subtitleStatus;
  }).catch(error => {
    if (generation !== trackGeneration || error.name === "AbortError") return;
    if (error.status === 401) showPairing(error);
    else if (!audio.error) playbackStatus.textContent = "暂时无法读取字幕。";
  });
}

function subtitleMessage(state) {
  return ({
    none: "此音轨没有可用的绑定字幕。",
    disabled: "此音轨的字幕已关闭。",
    unavailable: "无法加载此音轨的字幕。"
  })[state] || "";
}

function fileSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function updateImportControls() {
  element("import-packs").hidden = !offlineReady || !!importing;
  element("cancel-import").hidden = !importing;
}

function updateInstallControls() {
  installButton.hidden = !hosted || !offlineReady || offlineWorkId !== null
    || isStandalone() || appInstalled;
  if (installButton.hidden) installHelp.textContent = "";
}

async function showOffline() {
  const generation = ++viewGeneration;
  stopTrack();
  connection.textContent = "";
  view("offline");
  const list = element("offline-tracks");
  list.replaceChildren();
  const grid = element("offline-works");
  grid.replaceChildren();
  for (const url of offlineCoverUrls) URL.revokeObjectURL(url);
  offlineCoverUrls = [];
  updateImportControls();
  updateInstallControls();
  if (!offlineReady) return;
  try {
    const entries = await offlineStore.list();
    if (generation !== viewGeneration) return;
    work = null;
    element("offline-heading").textContent = "离线库";
    const works = new Map();
    for (const record of entries) {
      if (!works.has(record.workId)) works.set(record.workId, []);
      works.get(record.workId).push(record);
    }
    if (!works.has(offlineWorkId)) offlineWorkId = null;
    updateInstallControls();
    if (offlineWorkId) {
      tracks = works.get(offlineWorkId).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      element("offline-heading").textContent = tracks[0].workName;
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = "返回离线库";
      back.addEventListener("click", () => { offlineWorkId = null; void showOffline(); });
      grid.append(back);
    } else {
      tracks = [];
      for (const [id, records] of works) {
        const card = document.createElement("button");
        card.className = "work-card";
        const image = document.createElement("img");
        const url = records[0].cover ? URL.createObjectURL(records[0].cover) : "mark.png";
        if (records[0].cover) offlineCoverUrls.push(url);
        image.src = url;
        image.alt = "";
        card.append(image, `${records[0].workName} · ${records.length} 条`);
        card.addEventListener("click", () => { offlineWorkId = id; void showOffline(); });
        grid.append(card);
      }
    }
    const used = entries.reduce((sum, record) => sum + record.size + (record.cover?.size ?? 0), 0);
    element("offline-usage").textContent = entries.length
      ? `已保存 ${entries.length} 条音轨 · ${fileSize(used)}` : "暂无已保存音轨。";
    for (const [index, record] of tracks.entries()) {
      const row = document.createElement("li");
      const play = document.createElement("button");
      const detail = document.createElement("small");
      detail.textContent = `${record.workName} · ${fileSize(record.size)}`;
      play.append(record.trackName, detail);
      play.addEventListener("click", () => playOffline(index));
      const remove = document.createElement("button");
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${record.trackName}`);
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await offlineStore.remove(record);
          if (generation === viewGeneration) await showOffline();
        } catch {
          if (generation === viewGeneration) connection.textContent = "无法删除已保存音轨，请重试。";
          remove.disabled = false;
        }
      });
      row.append(play, remove);
      list.append(row);
    }
  } catch {
    if (generation === viewGeneration) connection.textContent = "无法读取离线库。";
  }
}

async function importPackages(files) {
  if (!files.length || importing) return;
  const status = element("import-status");
  importing = new AbortController();
  const { signal } = importing;
  updateImportControls();
  navigator.storage.persist?.().catch(() => {});
  const counts = { added: 0, updated: 0, skipped: 0 };
  const errors = [];
  const summary = () => `新增 ${counts.added} 条，更新 ${counts.updated} 条，跳过 ${counts.skipped} 条。`;
  try {
    for (const [index, file] of files.entries()) {
      signal.throwIfAborted();
      status.textContent = `正在检查第 ${index + 1}/${files.length} 个离线包…`;
      try {
        const pack = await offlineZip.inspect(file);
        signal.throwIfAborted();
        let processed = 0;
        status.textContent = `正在导入「${pack.workName}」 0/${pack.tracks.length} 条…`;
        await offlineStore.importPackage(pack, signal, outcome => {
          counts[outcome]++;
          status.textContent = `正在导入「${pack.workName}」 ${++processed}/${pack.tracks.length} 条…`;
        });
      } catch (error) {
        if (signal.aborted || error.name === "QuotaExceededError") throw error;
        errors.push(`${file.name}：${error instanceof SyntaxError ? "包内数据无效。" : error.message}`);
      }
    }
    status.textContent = errors.length ? `${summary()} ${errors.length} 个包未完成。${errors[0]}`
      : `导入完成。${summary()} 可以删除「下载」里的原包以释放空间。`;
  } catch (error) {
    status.textContent = `${signal.aborted ? "已取消导入。" : "手机存储空间不足。"}${summary()} 已完成的音轨仍可播放。`;
  } finally {
    importing = null;
    offlineWorkId = null;
    await showOffline();
  }
}

async function playOffline(index) {
  const record = tracks[index];
  if (!record) return;
  stopTrack();
  const generation = trackGeneration;
  playingOffline = true;
  trackIndex = index;
  connection.textContent = "";
  element("playing-work").textContent = record.workName;
  element("playing-track").textContent = record.trackName;
  if (record.cover) coverObjectUrl = URL.createObjectURL(record.cover);
  element("cover").src = coverObjectUrl || "mark.png";
  element("previous").disabled = index === 0;
  element("next").disabled = index === tracks.length - 1;
  view("player");
  try {
    const file = await offlineStore.getFile(record);
    if (generation !== trackGeneration) return;
    // File.slice preserves the disk-backed data while supplying its original MIME type.
    audioObjectUrl = URL.createObjectURL(file.slice(0, file.size, record.mime));
    audio.src = audioObjectUrl;
    installSubtitles(record.subtitles.entries);
    subtitleStatus = subtitleMessage(record.subtitles.state);
    playbackStatus.textContent = subtitleStatus;
    audio.play().catch(error => {
      if (generation === trackGeneration && error.name === "NotAllowedError") {
        playbackStatus.textContent = "请点击播放器的播放按钮。";
      }
    });
  } catch {
    if (generation === trackGeneration) playbackStatus.textContent = "本地音频已缺失，请重新导入离线包。";
  }
}

async function pairWithCode(code) {
  const button = element("pair-form").querySelector("button");
  if (button.disabled) return;
  button.disabled = true;
  connection.textContent = "正在配对…";
  try {
    await request("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    element("code").value = "";
    await showWorks();
  } catch (error) {
    showPairing(error);
  } finally {
    button.disabled = false;
  }
}

element("pair-form").addEventListener("submit", event => {
  event.preventDefault();
  void pairWithCode(element("code").value);
});

element("library-button").addEventListener("click", () => showWorks());
element("refresh").addEventListener("click", () => showWorks());
element("tracks-button").addEventListener("click", () => playingOffline ? showOffline() : showWork(work));
element("package-open").addEventListener("click", openPackageSelection);
element("package-close").addEventListener("click", () => { packageForm.hidden = true; });
element("package-tracks").addEventListener("change", updatePackageSelection);
element("package-all").addEventListener("change", event => {
  for (const input of element("package-tracks").querySelectorAll("input")) input.checked = event.target.checked;
  updatePackageSelection();
});
packageForm.addEventListener("submit", () => {
  element("package-help").hidden = false;
  element("hosted-library").hidden = false;
});
element("cancel-import").addEventListener("click", () => importing?.abort());
window.addEventListener("beforeinstallprompt", event => {
  if (!hosted || isStandalone() || appInstalled) return;
  event.preventDefault();
  installPrompt = event;
  installHelp.textContent = "";
});
window.addEventListener("appinstalled", () => {
  appInstalled = true;
  installPrompt = null;
  updateInstallControls();
});
standaloneMode.addEventListener("change", updateInstallControls);
installButton.addEventListener("click", async () => {
  const manualSteps = isAppleMobile()
    ? "在 Safari 点「分享 → 添加到主屏幕」，开启「作为网页 App 打开」，然后点「添加」。"
    : "打开浏览器菜单，选择「添加到主屏幕」或「安装应用」。";
  if (!installPrompt) {
    installHelp.textContent = manualSteps;
    return;
  }
  const prompt = installPrompt;
  installPrompt = null;
  installHelp.textContent = "";
  installButton.disabled = true;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      appInstalled = true;
      installPrompt = null;
      updateInstallControls();
    }
  } catch {
    if (!installButton.hidden) installHelp.textContent = manualSteps;
  } finally {
    installButton.disabled = false;
  }
});
element("pack-files").addEventListener("click", event => {
  if (!isStandalone() && isAppleMobile()) {
    event.preventDefault();
    element("import-status").textContent = "请先在 Safari 通过分享菜单添加到主屏幕，再从主屏幕打开并导入。";
  }
});
element("pack-files").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  void importPackages(files);
});
element("previous").addEventListener("click", () => (playingOffline ? playOffline : playTrack)(trackIndex - 1));
element("next").addEventListener("click", () => (playingOffline ? playOffline : playTrack)(trackIndex + 1));
subtitleScroll.addEventListener("wheel", pauseSubtitleFollowing, { passive: true });
subtitleScroll.addEventListener("touchmove", pauseSubtitleFollowing, { passive: true });
subtitleScroll.addEventListener("pointerdown", event => {
  if (event.pointerType === "mouse" && event.target === subtitleScroll) pauseSubtitleFollowing();
});
subtitleScroll.addEventListener("keydown", event => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)
      || (event.key === " " && event.target === subtitleScroll)) pauseSubtitleFollowing();
});
resumeSubtitles.addEventListener("click", () => {
  followingSubtitles = true;
  subtitleScroll.focus({ preventScroll: true });
  resumeSubtitles.hidden = true;
  const current = latestActiveCue(activeCues);
  if (current >= 0) {
    followCue(current);
    return;
  }
  // During a gap, return to the closest cue that has already started.
  const upcoming = cueRows.findIndex(cue => cue.start > audio.currentTime * 1000);
  followCue(Math.max(0, (upcoming < 0 ? cueRows.length : upcoming) - 1));
});
subtitleCues.addEventListener("click", event => {
  const button = event.target.closest(".subtitle-cue");
  if (!button || !audio.getAttribute("src") || audio.error) return;
  const index = Number(button.dataset.cue);
  const seconds = cueRows[index].start / 1000;
  if (Number.isFinite(audio.duration) && seconds > audio.duration) return;
  // Cancel a previous follow animation before a click chooses a new target.
  subtitleScroll.scrollTo({ top: subtitleScroll.scrollTop, behavior: "instant" });
  audio.currentTime = seconds;
  followingSubtitles = false;
  renderSubtitles();
  followingSubtitles = true;
  resumeSubtitles.hidden = true;
  followCue(index);
});
element("cover").addEventListener("error", event => {
  if (!event.target.src.endsWith("/mark.png")) event.target.src = "mark.png";
});
audio.addEventListener("playing", () => {
  playbackStatus.textContent = subtitleStatus;
  if (!frame) tick();
});
audio.addEventListener("waiting", () => {
  if (audio.getAttribute("src")) playbackStatus.textContent = "正在缓冲…";
});
for (const event of ["timeupdate", "seeking", "seeked", "pause", "ended"]) {
  audio.addEventListener(event, renderSubtitles);
}
audio.addEventListener("error", async () => {
  if (!audio.getAttribute("src")) return;
  if (playingOffline) {
    playbackStatus.textContent = "此设备无法播放已保存的音频。";
    return;
  }
  const generation = trackGeneration;
  playbackStatus.textContent = "无法播放。请检查电脑连接和音频文件，或尝试 MP3／常见 PCM WAV。";
  try {
    const response = await fetch(audio.src, { method: "HEAD" });
    if (generation !== trackGeneration) return;
    if (response.status === 401) showPairing(new Error("配对已失效，请重新配对。"));
    else if (response.status === 404) playbackStatus.textContent = "音轨不可用，请返回作品库刷新。";
  } catch {
    if (generation === trackGeneration) {
      playbackStatus.textContent = "已断开电脑连接。恢复网络后可重新选择音轨播放。";
    }
  }
});
async function startPlayer() {
  if (hosted && inWechat) {
    connection.textContent = "请从微信右上角菜单选择「在浏览器中打开」。";
    return;
  }
  if (hosted) {
    if (offlineStore.available) {
      try {
        await offlineStore.prepare();
        offlineReady = true;
      } catch {
        // The offline view shows the same guidance for unsupported or failed storage.
      }
    }
    await showOffline();
    if (!offlineReady) connection.textContent = "无法启用离线存储，请使用 Safari 或 Chrome 打开。";
    return;
  }
  const pairingFragment = location.hash;
  if (!pairingFragment.startsWith("#pair=")) {
    await showWorks(true);
    return;
  }
  // The fragment stays in the browser. Clear it before sending the one-time code.
  history.replaceState(history.state, "", location.pathname + location.search);
  const code = /^#pair=([0-9]{6})$/.exec(pairingFragment)?.[1];
  if (code) void pairWithCode(code);
  else showPairing(new Error("扫码链接无效，请重新扫码或输入六位配对码。"));
}
void startPlayer();
