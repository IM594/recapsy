import type { ScreenshotCreate, EntityCreate, ActivitySegmentCreate } from "@recaply/shared";
import { toLocalDate, toLocalHour } from "@recaply/shared";

const TEST_TZ = "Asia/Shanghai";

let counter = 0;
function nextId(): string {
  counter++;
  return `test-${counter}-${Date.now()}`;
}

export function createTestScreenshot(
  overrides?: Partial<ScreenshotCreate>,
): ScreenshotCreate {
  const now = new Date();
  return {
    path: `/tmp/screenshots/${nextId()}.webp`,
    timestamp: now,
    app_name: "Visual Studio Code",
    bundle_id: "com.microsoft.VSCode",
    window_title: "main.ts — recaply-sense",
    display_id: 1,
    ocr_text: "sample ocr text for testing",
    is_active: true,
    diff_ratio: 0.15,
    resolution: "2560x1440",
    file_size: 102400,
    capture_id: nextId(),
    timezone: TEST_TZ,
    local_date: toLocalDate(now, TEST_TZ),
    local_hour: toLocalHour(now, TEST_TZ),
    ...overrides,
  };
}

export function createTestEntity(
  overrides?: Partial<EntityCreate>,
): EntityCreate {
  const now = new Date();
  return {
    type: "app",
    name: `TestApp-${nextId()}`,
    first_seen: now,
    last_seen: now,
    ...overrides,
  };
}

export function createTestActivitySegment(
  overrides?: Partial<ActivitySegmentCreate>,
): ActivitySegmentCreate {
  const now = new Date();
  const end = new Date(now.getTime() + 300_000); // 5 minutes later
  return {
    app_name: "Visual Studio Code",
    bundle_id: "com.microsoft.VSCode",
    display_ids: [1],
    session_start: now,
    session_end: end,
    duration_seconds: 300,
    activity: "editing TypeScript files",
    scene_type: "coding",
    summary: "Working on recaply-sense engine implementation",
    visual_elements: ["editor", "file tree", "terminal"],
    key_entities: ["recaply-sense", "TypeScript"],
    screenshot_ids: [],
    frame_count: 150,
    selected_frame_count: 3,
    timezone: TEST_TZ,
    local_date: toLocalDate(now, TEST_TZ),
    llm_model: "gpt-4o-mini",
    llm_tokens_in: 2000,
    llm_tokens_out: 500,
    ...overrides,
  };
}
