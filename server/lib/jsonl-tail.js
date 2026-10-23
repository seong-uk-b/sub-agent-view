import fs from 'node:fs/promises';

const NL = 10;

/**
 * JSONL 파일을 바이트 오프셋으로 tail 한다.
 * - read()는 지난 호출 이후 추가된 바이트만 읽어 완성된 줄만 파싱해 돌려준다.
 * - 마지막 줄이 \n으로 끝나지 않으면 보관했다가 다음 read에서 이어 붙인다 (멀티바이트 안전).
 * - 깨진 줄은 건너뛴다. 파일이 없거나 잘리면 처음부터 다시 읽는다. 절대 throw 하지 않는다.
 */
export class JsonlTailer {
  constructor(filePath, { lineFilter, chunkSize = 1024 * 1024 } = {}) {
    this.filePath = filePath;
    this.lineFilter = lineFilter || null;
    this.chunkSize = chunkSize;      // 큰 파일도 이 크기씩 나눠 읽어 메모리 피크를 낮춘다
    this.offset = 0;
    this.partial = Buffer.alloc(0);
  }

  async read() {
    let handle;
    try {
      handle = await fs.open(this.filePath, 'r');
      const { size } = await handle.stat();
      if (size < this.offset) { this.offset = 0; this.partial = Buffer.alloc(0); }
      if (size === this.offset) return [];
      const out = [];
      while (this.offset < size) {
        const len = Math.min(this.chunkSize, size - this.offset);
        const chunk = Buffer.alloc(len);
        const { bytesRead } = await handle.read(chunk, 0, len, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        out.push(...this.#split(Buffer.concat([this.partial, chunk.subarray(0, bytesRead)])));
      }
      return out;
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  #split(buf) {
    const out = [];
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(NL, start);
      if (nl === -1) break;
      const line = buf.subarray(start, nl).toString('utf8');
      start = nl + 1;
      if (!line.trim()) continue;
      if (this.lineFilter && !this.lineFilter(line)) continue;
      try { out.push(JSON.parse(line)); } catch { /* 깨진 줄 무시 */ }
    }
    this.partial = Buffer.from(buf.subarray(start));
    return out;
  }
}
