import { PortPair } from "/midi/PortPair";
import { CallbackCollection, makeCallbackCollection } from "/util";

// TS merges this declaration with the `LedButton` class below
export interface LedButton extends MR_Button {
  setControlLayer: (controlLayer: MR_ControlLayer) => LedButton;
  setShapeCircle: () => LedButton;
  setShapeRectangle: () => LedButton;
  setTypePush: () => LedButton;
  setTypeToggle: () => LedButton;
}

interface LedButtonOptions {
  /**
   * The position and size of the button. If omitted, the button will be hidden.
   */
  position?: [x: number, y: number, w: number, h: number];

  /**
   * Whether or not the button belongs to a channel on the device. Defaults to `false`.
   */
  isChannelButton?: boolean;
}

/**
 * An extension to MR_Button that
 *
 *  * provides an `mLedValue` property which can be used to enable or disable the button's LED
 *    independently of the button's `mSurfaceValue`.
 *  * always lights up the button's LED while the button is being held down
 *  * can be configured to be invisible
 */
export class LedButton {
  /**
   * Binding the button's `mSurfaceValue` to a host function may alter it to not change when the
   * button is pressed. In order to reliably detect when the button is pressed, we create a
   * `shadowValue` variable that is bound to the same note.
   */
  private shadowValue = this.surface.makeCustomValueVariable("LedButtonProxy");

  private button: MR_Button;

  constructor(
    private readonly surface: MR_DeviceSurface,
    private readonly options: LedButtonOptions = {},
  ) {
    this.button = options.position
      ? surface.makeButton(...options.position)
      : ({
          mSurfaceValue: surface.makeCustomValueVariable("HiddenLedButton"),
          setControlLayer: () => this.button,
          setShapeCircle: () => this.button,
          setShapeRectangle: () => this.button,
          setTypePush: () => this.button,
          setTypeToggle: () => this.button,
        } as MR_Button);

    this.onSurfaceValueChange = makeCallbackCollection(
      this.button.mSurfaceValue,
      "mOnProcessValueChange",
    );

    return Object.assign(this.button, this) as LedButton;
  }

  onSurfaceValueChange: CallbackCollection<[MR_ActiveDevice, number, number]>;

  mLedValue = this.surface.makeCustomValueVariable("LedButtonLed");

  bindToNote = (ports: PortPair, note: number) => {
    this.button.mSurfaceValue.mMidiBinding.setInputPort(ports.input).bindToNote(0, note);
    this.onSurfaceValueChange.addCallback((context, newValue) => {
      ports.output.sendNoteOn(context, note, newValue || this.mLedValue.getProcessValue(context));
    });

    this.mLedValue.mOnProcessValueChange = (context, newValue) => {
      ports.output.sendNoteOn(context, note, newValue);
    };

    // Binding the button's mSurfaceValue to a host function may alter it to not change when the
    // button is pressed. Hence, `shadowValue` is used to make the button light up while it's
    // pressed.
    this.shadowValue.mMidiBinding.setInputPort(ports.input).bindToNote(0, note);
    this.shadowValue.mOnProcessValueChange = (context, newValue) => {
      ports.output.sendNoteOn(
        context,
        note,
        newValue ||
          this.button.mSurfaceValue.getProcessValue(context) ||
          this.mLedValue.getProcessValue(context),
      );
    };

    if (this.options.isChannelButton) {
      // Turn the button's LED off when it becomes unassigned
      this.button.mSurfaceValue.mOnTitleChange = (context, title) => {
        if (title === "") {
          ports.output.sendNoteOn(context, note, 0);
        }
      };
    }
  };
}