// Minimal typings for the extension APIs we use (no @types/chrome dependency).
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      tab?: { id?: number; url?: string };
    }
    const id: string;
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    function sendMessage<T>(message: unknown): Promise<T>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }
  namespace storage {
    interface StorageArea {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
  }
  namespace tabs {
    function create(properties: { url: string }): Promise<unknown>;
  }
}
