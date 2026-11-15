/**
 * Shown when getUserMedia fails with NotReadableError (another tab or app holds the webcam; on
 * Windows the Camera app or a second try-on window). Actionable: the kiosk offers Retry camera,
 * which calls getUserMedia again without a page reload (try-on and body scan).
 */
export const CAMERA_BUSY_HELP =
  'The camera is in use by another tab or app (for example the Windows Camera app or another try-on window). Close it, then press Retry camera.';
