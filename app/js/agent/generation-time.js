export function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000) || 0);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return (hours ? hours + ':' + String(minutes).padStart(2,'0') : String(minutes)) + ':' + String(seconds % 60).padStart(2,'0');
}
