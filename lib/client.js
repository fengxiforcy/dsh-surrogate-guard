/**
 * dsh-surrogate-guard —— 客户端（浏览器端）一半。
 *
 * 只做一件事：轮询宿主路由 /surrogate-guard/pending，发现新的修复记录就弹系统通知。
 * 起因：宿主插件 inject 进会话的消息，用户要「正好在看那个对话」才看得见；
 * 弹窗不依赖对话，是唯一稳妥的「修好了、请热重启」通道。
 */
window.__ModuleLoader__.load({
	id: "dsh-surrogate-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const PENDING_PATH = "/surrogate-guard/pending";
		const POLL_MS = 4000;
		let lastTs = 0;
		let timer = null;

		function showNotification(data) {
			try {
				if (typeof Notification === "undefined") return;
				const session = String(data.session || "未知会话");
				const body = "会话 " + session + " 中毒（半个 emoji），已自动修复并备份。请点「热重启」按钮后继续使用该会话。";
				if (Notification.permission === "default") {
					Notification.requestPermission().catch(() => {});
					return;
				}
				if (Notification.permission !== "granted") return;
				const n = new Notification("DSH 会话已自动修复", {
					body,
					tag: "surrogate-guard-" + data.ts,
				});
				n.onclick = () => {
					try { window.focus(); } catch { /* ignore */ }
					try { n.close(); } catch { /* ignore */ }
				};
			} catch { /* 通知失败不影响其它 */ }
		}

		async function poll() {
			try {
				const res = await fetch(PENDING_PATH, { headers: { accept: "application/json" } });
				if (!res.ok) return;
				const data = await res.json();
				if (!data || !data.ts || data.ts <= lastTs) return;
				lastTs = data.ts;
				showNotification(data);
			} catch { /* 宿主未就绪/路由未注册时静默 */ }
		}

		function apply(ctx) {
			poll();
			timer = setInterval(poll, POLL_MS);
			return () => { if (timer !== null) clearInterval(timer); };
		}

		exports.apply = apply;
		return module.exports;
	},
});
