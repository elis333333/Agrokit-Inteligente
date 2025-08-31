// Sketch integrado: sensores + GPS + batería + envío JSON
#include <Wire.h>
#include <Adafruit_BMP085.h>
#include <DHT.h>
#include "RTClib.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <TinyGPSPlus.h>

// Pines de sensores
#define PIN_DHT 5
#define DHTTYPE DHT11
#define PIN_HUMEDAD_TIERRA  32
#define PIN_SENSOR_AGUA     34  // leído digitalmente
#define PIN_LUZ             33
#define ONE_WIRE_BUS 2  

// Pines de relés
#define PIN_RELE_HUMEDAD1   15
#define PIN_RELE_HUMEDAD2   25

// Batería
#define PIN_BATERIA 35   // entrada ADC para medir voltaje batería
#define FACTOR_DIVISOR 2.0  // si usas divisor (ejemplo 100k/100k)

// GPS (ESP32 UART)
#define RXD2 16
#define TXD2 17
TinyGPSPlus gps;
HardwareSerial gpsSerial(2); // usar puerto 2 en ESP32

// Pantalla
#define ANCHO 128
#define ALTO 64
#define OLED_RESET -1
#define PIN_BOTON_SECUENCIA 4

Adafruit_BMP085 bmp;
DHT dht(PIN_DHT, DHTTYPE);
RTC_DS3231 rtc;
Adafruit_SSD1306 oled(ANCHO, ALTO, &Wire, OLED_RESET);
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

bool bmpOk = false;
DateTime horaActual;

// WiFi
const char* ssid = "GUAESC02";
const char* password = "98013798";

// Temporizador
unsigned long lastTime = 0;
unsigned long timerDelay = 30000; // 30s (ajusta según necesidad)

// Servidor
const char* serverUrl = "https://mi-dominio.com/api/sensores";
const bool USE_INSECURE = true;  // true para pruebas local, false en prod

// ---------------- FUNCIONES AUX ----------------
void mostrarInicio() {
  delay(1000);
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setCursor(0,0);
  oled.setTextSize(1);
  oled.print("Agro kit");
  oled.display();
}

void analisis() {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setCursor(0,0);
  oled.setTextSize(1);
  oled.print("Analisis Realizado");
  oled.display();
  delay(2000);
  oled.clearDisplay();
}

void evaluarHumedadSuelo(int valorPorc) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  oled.print("H. Suelo: ");
  oled.print(valorPorc);
  oled.print("%");
  oled.display();
  delay(1200);
}

void evaluarAguaDigital(int valor) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  oled.print("Agua: ");
  oled.print(valor == LOW ? "SI" : "NO"); // asumir LOW = presencia
  oled.display();
  delay(1200);
}

void evaluarLuz(int valorPorc) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  oled.print("Luz: ");
  oled.print(valorPorc);
  oled.print("%");
  oled.display();
  delay(1200);
}

void evaluarTemperatura(float temp) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  if (isnan(temp)) oled.print("Temp: Err");
  else {
    oled.print("Temp: ");
    oled.print(temp, 1);
    oled.print(" C");
  }
  oled.display();
  delay(1200);
}

void evaluarPresion(float presion) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  if (isnan(presion)) oled.print("Presion: Err");
  else {
    oled.print("Presion: ");
    oled.print(presion, 1);
    oled.print(" hPa");
  }
  oled.display();
  delay(1200);
}

void evaluarHumedadAire(float hum) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  if (isnan(hum)) oled.print("H. Aire: Err");
  else {
    oled.print("H. Aire: ");
    oled.print(hum, 0);
    oled.print(" %");
  }
  oled.display();
  delay(1200);
}

void evaluarTempSuelo(float tempC) {
  oled.clearDisplay();
  oled.setTextColor(WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  if (isnan(tempC)) oled.print("t. Tierra: Err");
  else {
    oled.print("t. Tierra: ");
    oled.print(tempC, 1);
    oled.print(" C");
  }
  oled.display();
  delay(1200);
}

float leerBateriaPorc() {
  int raw = analogRead(PIN_BATERIA);
  // lectura ADC esp32: 0..4095 -> 0..Vref (normalmente 3.3)
  float volt = (raw / 4095.0f) * 3.3f * FACTOR_DIVISOR;
  // conv a % entre 3.3V y 4.2V (ajusta si tu pack diferente)
  float pct = ( (volt - 3.3f) / (4.2f - 3.3f) ) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

void leerGPS(float &lat, float &lon) {
  // lee bytes disponibles y actualiza último valor conocido
  static float lastLat = 0.0f, lastLon = 0.0f;
  while (gpsSerial.available() > 0) {
    gps.encode(gpsSerial.read());
    if (gps.location.isUpdated()) {
      lastLat = gps.location.lat();
      lastLon = gps.location.lng();
    }
  }
  lat = lastLat;
  lon = lastLon;
}

void mostrarSecuenciaSensoresPantalla(int aguaDigital, int humSueloPct, float tempSuelo, float tempAmbient, int luzPct, float humAire, float presion) {
  evaluarAguaDigital(aguaDigital);
  evaluarHumedadSuelo(humSueloPct);
  evaluarTempSuelo(tempSuelo);
  evaluarTemperatura(tempAmbient);
  evaluarLuz(luzPct);
  evaluarHumedadAire(humAire);
  evaluarPresion(presion);
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  dht.begin();
  Wire.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.clearDisplay();
  sensors.begin();

  pinMode(PIN_RELE_HUMEDAD1, OUTPUT);
  pinMode(PIN_RELE_HUMEDAD2, OUTPUT);
  digitalWrite(PIN_RELE_HUMEDAD1, LOW);
  digitalWrite(PIN_RELE_HUMEDAD2, LOW);

  pinMode(PIN_BOTON_SECUENCIA, INPUT_PULLUP);
  pinMode(PIN_SENSOR_AGUA, INPUT); // digital input
  // PIN_HUMEDAD_TIERRA is analog input (no pinMode needed)
  // PIN_BATERIA analog input (no pinMode needed)

  bmpOk = bmp.begin();
  if (!rtc.begin()) {
    Serial.println("RTC no encontrado - detener.");
    while (1) delay(1000);
  }

  // WiFi
  WiFi.begin(ssid, password);
  Serial.print("Conectando WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) Serial.println("WiFi conectado");
  else Serial.println("WiFi NO conectado - seguiré intentandolo en loop");

  // GPS init (HardwareSerial 2)
  gpsSerial.begin(9600, SERIAL_8N1, RXD2, TXD2);

  mostrarInicio();
  Serial.println("Sistema listo.");
}

// ---------------- LOOP ----------------
void loop() {
  // botón para mostrar secuencia manual
  if (digitalRead(PIN_BOTON_SECUENCIA) == LOW) {
    // lee valores puntuales para mostrar
    int aguaDig = digitalRead(PIN_SENSOR_AGUA);
    int humSueloPct = map(analogRead(PIN_HUMEDAD_TIERRA), 0, 4095, 0, 100);
    sensors.requestTemperatures();
    float tempSuelo = sensors.getTempCByIndex(0);
    float tempAmbient = dht.readTemperature();
    int luzPct = map(analogRead(PIN_LUZ), 0, 4095, 0, 100);
    float humAire = dht.readHumidity();
    float presion = bmpOk ? (bmp.readPressure() / 100.0f) : NAN;

    mostrarSecuenciaSensoresPantalla(aguaDig, humSueloPct, tempSuelo, tempAmbient, luzPct, humAire, presion);
    analisis();
    Serial.println("Secuencia mostrada (boton).");
    delay(800);
  }

  // Lógica relés: ejemplo con humedad suelo (%) y sensor agua digital
  int aguaDigital = digitalRead(PIN_SENSOR_AGUA); // LOW = agua (depende de tu sensor)
  int humSueloRaw = analogRead(PIN_HUMEDAD_TIERRA);
  int humSueloPct = map(humSueloRaw, 0, 4095, 0, 100);

  // umbral ejemplo: si NO hay agua (sensor=HIGH) y suelo < 45% -> encender riego
  if ( (aguaDigital == HIGH) && (humSueloPct < 45) ) {
    digitalWrite(PIN_RELE_HUMEDAD1, HIGH);
    digitalWrite(PIN_RELE_HUMEDAD2, HIGH);
    Serial.println("Riego: ENCENDIDO");
  } else {
    digitalWrite(PIN_RELE_HUMEDAD1, LOW);
    digitalWrite(PIN_RELE_HUMEDAD2, LOW);
  }

  horaActual = rtc.now();

  if ((millis() - lastTime) > timerDelay) {
    // Lecturas sensores
    float temperatura = bmpOk ? bmp.readTemperature() : NAN;
    float humedad = dht.readHumidity();
    float presion = bmpOk ? (bmp.readPressure() / 100.0f) : NAN;
    int luz = map(analogRead(PIN_LUZ), 0, 4095, 0, 100);
    int agua = digitalRead(PIN_SENSOR_AGUA); // 0/1 (LOW/HIGH)
    int humedadTierra = map(analogRead(PIN_HUMEDAD_TIERRA), 0, 4095, 0, 100);
    sensors.requestTemperatures();
    float tempC = sensors.getTempCByIndex(0);

    // GPS
    float lat = 0.0f, lon = 0.0f;
    leerGPS(lat, lon);

    // Batería
    float bateriaPct = leerBateriaPorc();

    // Fecha hora
    char fechaHoraBuffer[25];
    sprintf(fechaHoraBuffer, "%04d-%02d-%02d %02d:%02d:%02d",
            horaActual.year(), horaActual.month(), horaActual.day(),
            horaActual.hour(), horaActual.minute(), horaActual.second());

    // Construir JSON (valores null si NaN)
    String json = "{";
    json += "\"id_agrokit\":\"KIT123\",";
    json += "\"humedad_tierra\":" + String(humedadTierra) + ",";
    json += "\"temp_aire\":" + (isnan(temperatura) ? String("null") : String(temperatura,2)) + ",";
    json += "\"humedad_aire\":" + (isnan(humedad) ? String("null") : String(humedad,1)) + ",";
    json += "\"temp_suelo\":" + (isnan(tempC) ? String("null") : String(tempC,2)) + ",";
    json += "\"agua\":" + String(agua) + ",";
    json += "\"luz\":" + String(luz) + ",";
    json += "\"presion\":" + (isnan(presion) ? String("null") : String(presion,2)) + ",";
    json += "\"gps\":{\"lat\":" + String(lat,6) + ",\"lon\":" + String(lon,6) + "},";
    json += "\"bateria\":" + String(bateriaPct,1) + ",";
    json += "\"fechaHora\":\"" + String(fechaHoraBuffer) + "\"";
    json += "}";

    Serial.println("Enviando datos: " + json);

    // Envío al servidor
    if (WiFi.status() == WL_CONNECTED) {
      WiFiClientSecure client;
      HTTPClient https;
      if (USE_INSECURE) client.setInsecure(); // solo para pruebas
      if (https.begin(client, serverUrl)) {
        https.addHeader("Content-Type", "application/json");
        int httpCode = https.POST(json);
        Serial.println("HTTP code: " + String(httpCode));
        if (httpCode > 0) {
          String payload = https.getString();
          Serial.println("Respuesta server: " + payload);
        } else {
          Serial.println("Error POST: " + https.errorToString(httpCode));
        }
        https.end();
      } else {
        Serial.println("https.begin() falló");
      }
    } else {
      Serial.println("WiFi no conectado - reintentando conexión...");
      WiFi.reconnect();
    }

    lastTime = millis();
  }

  // procesar GPS bytes continuamente (mejora precisión)
  while (gpsSerial.available() > 0) gps.encode(gpsSerial.read());
  delay(50);
}

