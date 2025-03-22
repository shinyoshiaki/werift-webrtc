[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / videoOrientationPayload

# Interface: videoOrientationPayload

## Properties

### c

> **c**: `number`

Camera: indicates the direction of the camera used for this video stream. It can be used by the MTSI client in
receiver to e.g. display the received video differently depending on the source camera.
0: Front-facing camera, facing the user. If camera direction is unknown by the sending MTSI client in the terminal
then this is the default value used.
1: Back-facing camera, facing away from the user.

***

### f

> **f**: `number`

F = Flip: indicates a horizontal (left-right flip) mirror operation on the video as sent on the link.
0: No flip operation. If the sending MTSI client in terminal does not know if a horizontal mirror operation is
necessary, then this is the default value used.
1: Horizontal flip operation

***

### r0

> **r0**: `number`

***

### r1

> **r1**: `number`

R1, R0 = Rotation: indicates the rotation of the video as transmitted on the link. The receiver should rotate the video to
compensate that rotation. E.g. a 90° Counter Clockwise rotation should be compensated by the receiver with a 90°
Clockwise rotation prior to displaying. 

 +----+----+-----------------------------------------------+------------------------------+
| R1 | R0 | Rotation of the video as sent on the link     | Rotation on the receiver      |
|    |    |                                               | before display                |
+----+----+-----------------------------------------------+------------------------------+
|  0 |  0 | 0° rotation                                   | None                         |
+----+----+-----------------------------------------------+------------------------------+
|  0 |  1 | 90° Counter Clockwise (CCW) rotation or 270°  | 90° Clockwise (CW) rotation  |
|    |    | Clockwise (CW) rotation                       |                              |
+----+----+-----------------------------------------------+------------------------------+
|  1 |  0 | 180° CCW rotation or 180° CW rotation         | 180° CW rotation             |
+----+----+-----------------------------------------------+------------------------------+
|  1 |  1 | 270° CCW rotation or 90° CW rotation          | 90° CCW rotation             |
+----+----+-----------------------------------------------+------------------------------+
