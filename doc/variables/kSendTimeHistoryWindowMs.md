[**werift**](../README.md)

***

[werift](../globals.md) / kSendTimeHistoryWindowMs

# Variable: kSendTimeHistoryWindowMs

> `const` **kSendTimeHistoryWindowMs**: `60000` = `60_000`

pin `TransportFeedbackAdapter` `kSendTimeHistoryWindow` = 60s.
Sent packet history (and never-ACK probe estimator maps) live this long
so late TWCC can still match. Not a 2048-sequence cap.
