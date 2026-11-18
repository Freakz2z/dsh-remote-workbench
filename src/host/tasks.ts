import { randomUUID } from "node:crypto";
import type { Host, Task } from "../shared/types.ts";
import type { Store } from "./store.ts";

export class TaskManager {
  readonly controllers = new Map<string, AbortController>();
  constructor(private store: Store) {}
  async start(
    host: Host,
    kind: Task["kind"],
    label: string,
    details?: Pick<Task, "command">,
  ) {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      hostId: host.id,
      hostName: host.name,
      kind,
      label,
      status: "running",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      ...details,
    };
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.store.task(task);
    await this.store.persist();
    return { task, signal: controller.signal };
  }
  update(task: Task, patch: Partial<Task>) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.store.task(task);
  }
  async finish(task: Task, patch: Partial<Task>) {
    this.update(task, patch);
    this.controllers.delete(task.id);
    await this.store.persist();
  }
  cancel(id: string) {
    this.controllers
      .get(id)
      ?.abort(new DOMException("用户取消了操作", "AbortError"));
  }
  async dispose() {
    for (const c of this.controllers.values()) c.abort();
    await this.store.flush();
  }
}
