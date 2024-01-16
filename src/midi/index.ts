import { config } from "../config";
import { TouchSensitiveFader } from "../decorators/surface";
import { Device, MainDevice } from "../devices";
import { GlobalState } from "../state";
import { ContextStateVariable } from "../util";
import { PortPair } from "./PortPair";
import { ActivationCallbacks } from "./connection";
import { RgbColor } from "./managers/ColorManager";
import { sendChannelMeterMode, sendGlobalMeterModeOrientation, sendMeterLevel } from "./util";

export enum EncoderDisplayMode {
  SingleDot = 0,
  BoostOrCut = 1,
  Wrap = 2,
  Spread = 3,
}

export function bindDeviceToMidi(
  device: Device,
  globalState: GlobalState,
  activationCallbacks: ActivationCallbacks,
) {
  const ports = device.ports;

  function bindFader(ports: PortPair, fader: TouchSensitiveFader, faderIndex: number) {
    fader.mSurfaceValue.mMidiBinding.setInputPort(ports.input).bindToPitchBend(faderIndex);
    fader.mTouchedValue.mMidiBinding.setInputPort(ports.input).bindToNote(0, 104 + faderIndex);
    fader.mTouchedValueInternal.mMidiBinding
      .setInputPort(ports.input)
      .bindToNote(0, 104 + faderIndex);

    const sendValue = (context: MR_ActiveDevice, value: number) => {
      value *= 0x3fff;
      ports.output.sendMidi(context, [0xe0 + faderIndex, value & 0x7f, value >> 7]);
    };

    const isFaderTouched = new ContextStateVariable(false);
    fader.mTouchedValueInternal.mOnProcessValueChange = (context, value) => {
      const isFaderTouchedValue = Boolean(value);
      isFaderTouched.set(context, isFaderTouchedValue);
      if (!isFaderTouchedValue) {
        sendValue(context, lastFaderValue.get(context));
      }
    };

    const forceUpdate = new ContextStateVariable(true);
    const lastFaderValue = new ContextStateVariable(0);
    fader.mSurfaceValue.mOnProcessValueChange = (context, newValue, difference) => {
      // Prevent identical messages to reduce fader noise
      if (
        globalState.areMotorsActive.get(context) &&
        !isFaderTouched.get(context) &&
        (difference !== 0 || lastFaderValue.get(context) === 0 || forceUpdate.get(context))
      ) {
        forceUpdate.set(context, false);
        sendValue(context, newValue);
      }

      lastFaderValue.set(context, newValue);
    };

    // Set fader to `0` when unassigned
    fader.mSurfaceValue.mOnTitleChange = (context, title) => {
      if (title === "") {
        forceUpdate.set(context, true);
        fader.mSurfaceValue.setProcessValue(context, 0);
        // `mOnProcessValueChange` somehow isn't run here on `setProcessValue()`, hence:
        lastFaderValue.set(context, 0);
        if (globalState.areMotorsActive.get(context)) {
          forceUpdate.set(context, false);
          sendValue(context, 0);
        }
      }
    };

    globalState.areMotorsActive.addOnChangeCallback((context, areMotorsActive) => {
      if (areMotorsActive) {
        sendValue(context, lastFaderValue.get(context));
      }
    });
  }

  for (const [channelIndex, channel] of device.channelElements.entries()) {
    // Push Encoder
    channel.encoder.mEncoderValue.mMidiBinding
      .setInputPort(ports.input)
      .bindToControlChange(0, 16 + channelIndex)
      .setTypeRelativeSignedBit();
    channel.encoder.mPushValue.mMidiBinding
      .setInputPort(ports.input)
      .bindToNote(0, 32 + channelIndex);
    channel.encoder.mEncoderValue.mOnProcessValueChange = (context, newValue) => {
      const displayMode = channel.encoder.mDisplayModeValue.getProcessValue(context);

      const isCenterLedOn = newValue === (displayMode === EncoderDisplayMode.Spread ? 0 : 0.5);
      const position =
        1 + Math.round(newValue * (displayMode === EncoderDisplayMode.Spread ? 5 : 10));

      ports.output.sendMidi(context, [
        0xb0,
        0x30 + channelIndex,
        (+isCenterLedOn << 6) + (displayMode << 4) + position,
      ]);
    };

    // Display colors – only supported by the X-Touch
    if (DEVICE_NAME === "X-Touch") {
      const encoderColor = new ContextStateVariable({ isAssigned: false, r: 0, g: 0, b: 0 });
      channel.encoder.mEncoderValue.mOnColorChange = (context, r, g, b, _a, isAssigned) => {
        encoderColor.set(context, { isAssigned, r, g, b });
        updateColor(context);
      };

      const channelColor = new ContextStateVariable({ isAssigned: false, r: 0, g: 0, b: 0 });
      channel.scribbleStrip.trackTitle.mOnColorChange = (context, r, g, b, _a, isAssigned) => {
        channelColor.set(context, { isAssigned, r, g, b });
        updateColor(context);
      };

      var updateColor = (context: MR_ActiveDevice) => {
        let color: RgbColor;
        const currentEncoderColor = encoderColor.get(context);
        const currentChannelColor = channelColor.get(context);

        if (config.displayColorMode === "encoders") {
          // Fall back to channel color if encoder is not assigned
          color = currentEncoderColor.isAssigned ? currentEncoderColor : currentChannelColor;
        } else if (config.displayColorMode === "channels") {
          color = currentChannelColor;

          // Use white if an encoder has a color but the channel has none. Otherwise, encoder titles
          // on unassigned channels would not be readable.
          if (!currentChannelColor.isAssigned && currentEncoderColor.isAssigned) {
            color = { r: 1, g: 1, b: 1 };
          }
        } else {
          color =
            currentChannelColor.isAssigned || currentEncoderColor.isAssigned
              ? { r: 1, g: 1, b: 1 }
              : { r: 0, g: 0, b: 0 };
        }

        device.colorManager?.setChannelColorRgb(context, channelIndex, color);
      };
    }

    // Scribble Strip
    const channelTextManager = device.lcdManager.getChannelTextManager(channelIndex);

    channel.encoder.mEncoderValue.mOnTitleChange = (context, title1, title2) => {
      // Reset encoder LED ring when channel becomes unassigned
      if (title1 === "") {
        ports.output.sendMidi(context, [0xb0, 0x30 + channelIndex, 0]);
      }

      channelTextManager.setParameterName(context, title2);
    };

    channel.encoder.mEncoderValue.mOnDisplayValueChange = (context, value) => {
      channelTextManager.setParameterValue(context, value);
    };

    channel.scribbleStrip.trackTitle.mOnTitleChange = (context, title) => {
      channelTextManager.setChannelName(context, title);

      if (DEVICE_NAME === "MCU Pro") {
        clearOverload(context);
      }
    };

    // VU Meter
    let lastMeterUpdateTime = 0;
    channel.vuMeter.mOnProcessValueChange = (context, newValue) => {
      const now: number = performance.now(); // ms

      if (now - lastMeterUpdateTime > 125) {
        lastMeterUpdateTime = now;

        // Apply a log scale twice to make the meters look more like Cubase's MixConsole meters
        const meterLevel = Math.ceil(
          (1 + Math.log10(0.1 + 0.9 * (1 + Math.log10(0.1 + 0.9 * newValue)))) * 0xe - 0.25,
        );

        sendMeterLevel(context, ports.output, channelIndex, meterLevel);
      }
    };

    if (DEVICE_NAME === "MCU Pro") {
      globalState.areChannelMetersEnabled.addOnChangeCallback(
        (context, areMetersEnabled) => {
          sendChannelMeterMode(context, ports.output, channelIndex, areMetersEnabled);
        },
        0, // priority = 0: Disable channel meters *before* updating the lower display row
      );
    }

    /** Clears the channel meter's overload indicator */
    const clearOverload = (context: MR_ActiveDevice) => {
      sendMeterLevel(context, ports.output, channelIndex, 0xf);
    };

    globalState.shouldMeterOverloadsBeCleared.addOnChangeCallback(
      (context, shouldOverloadsBeCleared) => {
        if (shouldOverloadsBeCleared) {
          clearOverload(context);
        }
      },
    );

    // Channel Buttons
    const buttons = channel.buttons;
    for (const [row, button] of [
      buttons.record,
      buttons.solo,
      buttons.mute,
      buttons.select,
    ].entries()) {
      button.bindToNote(ports, row * 8 + channelIndex, true);
    }

    // Fader
    bindFader(ports, channel.fader, channelIndex);
  }

  if (DEVICE_NAME === "MCU Pro") {
    // Handle metering mode changes (globally)
    globalState.isGlobalLcdMeterModeVertical.addOnChangeCallback((context, isMeterModeVertical) => {
      sendGlobalMeterModeOrientation(context, ports.output, isMeterModeVertical);
    });
  }

  if (DEVICE_NAME === "X-Touch") {
    // Send an initial (all-black by default) color message to the device. Otherwise, in projects
    // without enough channels for each device, devices without channels assigned to them would not
    // receive a color update at all, leaving their displays white although they should be black.
    activationCallbacks.addCallback((context) => {
      device.colorManager?.sendColors(context);
    });
  }

  // Control Section (main devices only)
  if (device instanceof MainDevice) {
    const elements = device.controlSectionElements;
    const buttons = elements.buttons;

    activationCallbacks.addCallback((context) => {
      // Workaround for https://forums.steinberg.net/t/831123:
      ports.output.sendNoteOn(context, 0x4f, 1);

      // Workaround for encoder assign buttons not being enabled on activation
      // (https://forums.steinberg.net/t/831123):
      ports.output.sendNoteOn(context, 0x2a, 1);
      for (const note of [0x28, 0x29, 0x2b, 0x2c, 0x2d]) {
        ports.output.sendNoteOn(context, note, 0);
      }
    });

    bindFader(ports, elements.mainFader, 8);

    for (const [index, button] of [
      ...[0, 3, 1, 4, 2, 5].map((index) => buttons.encoderAssign[index]),
      buttons.navigation.bank.left,
      buttons.navigation.bank.right,
      buttons.navigation.channel.left,
      buttons.navigation.channel.right,
      buttons.flip,
      buttons.edit,
      buttons.display,
      buttons.timeMode,
      ...buttons.function,
      ...buttons.number,
      ...buttons.modify,
      ...buttons.automation,
      ...buttons.utility,
      ...buttons.transport,
      buttons.navigation.directions.up,
      buttons.navigation.directions.down,
      buttons.navigation.directions.left,
      buttons.navigation.directions.right,
      buttons.navigation.directions.center,
      buttons.scrub,
    ].entries()) {
      button.bindToNote(ports, 40 + index);
    }

    // Segment Display - handled by the SegmentDisplayManager, except for:
    const { smpte, beats, solo } = elements.displayLeds;
    [smpte, beats, solo].forEach((lamp, index) => {
      lamp.bindToNote(ports.output, 0x71 + index);
    });

    // Jog wheel
    elements.jogWheel.bindToControlChange(ports.input, 0x3c);

    // Foot control
    for (const [index, footSwitch] of elements.footSwitches.entries()) {
      footSwitch.mSurfaceValue.mMidiBinding.setInputPort(ports.input).bindToNote(0, 0x66 + index);
    }
    elements.expressionPedal.mSurfaceValue.mMidiBinding
      .setInputPort(ports.input)
      .bindToControlChange(0, 0x2e)
      .setTypeAbsolute();
  }
}
