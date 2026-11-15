import vm from "vm";

type MessageListener = (event: { data: unknown; source: unknown }) => unknown;

export type FrameWindow = Record<string, any>;

/**
 * upstream WPT の perfect-negotiation helper が使う最小限の window / document / iframe を、
 * vm コンテキスト上に用意する。Node の runner には DOM がないので、
 * `postMessage` による window 間通信と、`srcdoc` のスクリプトを別コンテキストで実行する iframe だけを再現する。
 * 値を上書きしたり werift の挙動を変えたりはしない。
 */
export function installMessageWindow(
  target: FrameWindow,
  options: { postMessageTarget?: () => FrameWindow },
) {
  const listeners = new Set<MessageListener>();
  target.onmessage = null;
  target.addEventListener = (type: string, listener: MessageListener) => {
    if (type === "message") {
      listeners.add(listener);
    }
  };
  target.removeEventListener = (type: string, listener: MessageListener) => {
    if (type === "message") {
      listeners.delete(listener);
    }
  };
  target.postMessage = (data: unknown) => {
    // ブラウザと同じく、メッセージは非同期に配信する
    setTimeout(() => {
      const event = { data, source: options.postMessageTarget?.() };
      if (typeof target.onmessage === "function") {
        void Promise.resolve(target.onmessage(event)).catch(() => undefined);
      }
      for (const listener of [...listeners]) {
        void Promise.resolve(listener(event)).catch(() => undefined);
      }
    }, 0);
  };
}

export function installDocumentWithIframe(input: {
  top: FrameWindow;
  extractScripts: (html: string) => { content: string; src?: string }[];
  createChild: () => {
    window: FrameWindow;
    context: vm.Context;
    close: () => Promise<void>;
  };
  onChildClose: (close: () => Promise<void>) => void;
}) {
  const { top } = input;
  const createElement = (tag: string) => {
    if (tag !== "iframe") {
      throw new Error(`document.createElement("${tag}") is not supported`);
    }
    const iframe: Record<string, any> = {
      srcdoc: "",
      onload: null,
      contentWindow: null,
      remove() {
        const close = iframe.__close as (() => Promise<void>) | undefined;
        iframe.__close = undefined;
        iframe.contentWindow = null;
        void close?.();
      },
    };
    return iframe;
  };
  top.document = {
    createElement,
    getElementsByTagName: () => [],
    documentElement: {
      appendChild(iframe: Record<string, any>) {
        const child = input.createChild();
        iframe.contentWindow = child.window;
        iframe.__close = child.close;
        input.onChildClose(child.close);
        for (const script of input.extractScripts(String(iframe.srcdoc))) {
          vm.runInContext(script.content, child.context, {
            filename: "iframe-srcdoc",
          });
        }
        setTimeout(() => iframe.onload?.({ target: iframe }), 0);
        return iframe;
      },
    },
  };
}
