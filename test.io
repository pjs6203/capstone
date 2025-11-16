// Simple GPIO14 toggler: turns pin ON/OFF every 1 second

const int PIN_GPIO14 = 14;
const unsigned long TOGGLE_INTERVAL_MS = 1000;

unsigned long lastToggle = 0;
bool pinState = false;

void setup() {
	pinMode(PIN_GPIO14, OUTPUT);
	digitalWrite(PIN_GPIO14, LOW);
	lastToggle = millis();
}

void loop() {
	unsigned long now = millis();
	if (now - lastToggle >= TOGGLE_INTERVAL_MS) {
		pinState = !pinState;
		digitalWrite(PIN_GPIO14, pinState ? HIGH : LOW);
		lastToggle = now;
	}
}
