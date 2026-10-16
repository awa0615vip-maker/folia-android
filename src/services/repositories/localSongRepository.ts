import type { LocalSong } from '../../types';
import { isBlob } from '../../utils/blobGuards';
import { migrateLocalSongsRenderHints, migrateMatchedLyricsCarrierRenderHints } from '../../utils/lyrics/storageMigration';
import { appDatabase } from '../appDatabase';
import { noteLocalLibraryDiagnostic } from '../../utils/localLibraryDiagnostics';

// src/services/repositories/localSongRepository.ts
// Stores sanitized local-song records while retaining the existing read-time lyric migrations.

export const sanitizeLocalSongForStorage = (song: LocalSong): LocalSong => {
  const normalizedSong = migrateMatchedLyricsCarrierRenderHints(song).value ?? song;
  const { fileHandle, embeddedCover: _legacyCover, ...persistedSong } = normalizedSong as LocalSong & {
    embeddedCover?: unknown;
  };
  return persistedSong;
};

const normalizeLocalSongFromStorage = (song: LocalSong): { value: LocalSong; changed: boolean } => {
  const legacySong = song as LocalSong & { embeddedCover?: unknown };
  if (legacySong.embeddedCover === undefined) return { value: song, changed: false };
  const { embeddedCover, ...normalizedSong } = legacySong;
  // A valid legacy Blob remains in IndexedDB until the background migrator commits external storage.
  return { value: normalizedSong, changed: !isBlob(embeddedCover) };
};

export const putLocalSong = async (song: LocalSong): Promise<void> => {
  await appDatabase.local_music.put(sanitizeLocalSongForStorage(song));
};

export const putLocalSongs = async (songs: LocalSong[]): Promise<void> => {
  if (songs.length > 0) {
    await appDatabase.local_music.bulkPut(songs.map(sanitizeLocalSongForStorage));
  }
};

const LOCAL_SONG_MAINTENANCE_CHUNK = 64;

// Applies the read-time cover sanitization and lyric render-hint migration, writing changed records back in the background.
// Used for single-record reads (readLocalSong); bulk reads use the chunked readLocalSongs below to avoid blocking the main thread.
const migrateStoredLocalSongs = (storedSongs: LocalSong[]): LocalSong[] => {
  const normalized = storedSongs.map(normalizeLocalSongFromStorage);
  const sanitizedSongs = normalized.filter(item => item.changed).map(item => item.value);
  if (sanitizedSongs.length > 0) {
    void putLocalSongs(sanitizedSongs).catch(error => {
      console.warn('[DB] Failed to write back sanitized local song covers', error);
    });
  }

  const migration = migrateLocalSongsRenderHints(normalized.map(item => item.value));
  if (migration.changedSongs.length > 0) {
    void putLocalSongs(migration.changedSongs).catch(error => {
      console.warn('[DB] Failed to write back migrated local song lyrics', error);
    });
  }
  return migration.value;
};

const yieldToMainThread = (): Promise<void> => (
  new Promise(resolve => setTimeout(resolve, 0))
);

export const readLocalSongs = async (): Promise<LocalSong[]> => {
  const startedAt = Date.now();
  noteLocalLibraryDiagnostic('read:start');
  try {
    const storedSongs = await appDatabase.local_music.toArray();
    const readDoneAt = Date.now();
    // Let IndexedDB's onsuccess callback finish before doing per-record migration work; otherwise
    // a large library makes that callback itself a long task and stalls playback startup.
    await yieldToMainThread();

    const normalizedSongs: LocalSong[] = [];
    const sanitizedSongs: LocalSong[] = [];
    for (let index = 0; index < storedSongs.length; index += 1) {
      const normalized = normalizeLocalSongFromStorage(storedSongs[index]);
      normalizedSongs.push(normalized.value);
      if (normalized.changed) sanitizedSongs.push(normalized.value);
      if ((index + 1) % LOCAL_SONG_MAINTENANCE_CHUNK === 0) {
        await yieldToMainThread();
      }
    }

    if (sanitizedSongs.length > 0) {
      void putLocalSongs(sanitizedSongs).catch(error => {
        console.warn('[DB] Failed to write back sanitized local song covers', error);
      });
    }

    const migratedSongs: LocalSong[] = [];
    const migratedChangedSongs: LocalSong[] = [];
    for (let index = 0; index < normalizedSongs.length; index += LOCAL_SONG_MAINTENANCE_CHUNK) {
      const migration = migrateLocalSongsRenderHints(
        normalizedSongs.slice(index, index + LOCAL_SONG_MAINTENANCE_CHUNK),
      );
      migratedSongs.push(...migration.value);
      migratedChangedSongs.push(...migration.changedSongs);
      if (index + LOCAL_SONG_MAINTENANCE_CHUNK < normalizedSongs.length) {
        await yieldToMainThread();
      }
    }

    if (migratedChangedSongs.length > 0) {
      void putLocalSongs(migratedChangedSongs).catch(error => {
        console.warn('[DB] Failed to write back migrated local song lyrics', error);
      });
    }

    noteLocalLibraryDiagnostic('read:done', {
      songs: migratedSongs.length,
      readMs: readDoneAt - startedAt,
      totalMs: Date.now() - startedAt,
    });
    return migratedSongs;
  } catch (error) {
    noteLocalLibraryDiagnostic('read:error', {
      totalMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

// 按主键读一条记录，读时迁移与 readLocalSongs 一致；播放和匹配路径只关心一首歌时用它，不读整张表。
export const readLocalSong = async (id: string): Promise<LocalSong | undefined> => {
  const storedSong = await appDatabase.local_music.get(id);
  return storedSong ? migrateStoredLocalSongs([storedSong])[0] : undefined;
};

export const removeLocalSong = async (id: string): Promise<void> => {
  await appDatabase.local_music.delete(id);
};

export const removeLocalSongs = async (ids: string[]): Promise<void> => {
  if (ids.length > 0) {
    await appDatabase.local_music.bulkDelete(ids);
  }
};

