# Generates the spoken founder answers the live-room load test streams to the
# server, as 16 kHz mono 16-bit WAV (the format Azure STT receives from the
# browser's pcm-processor). Uses the Windows built-in speech synthesizer, so it
# costs nothing and needs no network. Each line is one sentence held together
# with commas, so the recognizer returns it as a single utterance.
#
# Usage (from backend/): powershell -File scripts/loadtest/makeAudio.ps1
param([string]$OutDir = (Join-Path $PSScriptRoot "out/audio"))

Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null

$lines = @(
  "Good morning panel, my name is Ada and I am the founder of FarmLink, a marketplace that connects smallholder farmers in Nigeria directly with restaurants and supermarkets, so farmers are paid fairly and buyers get fresher produce.",
  "Today farmers lose up to forty percent of their harvest to spoilage and middlemen, and they often wait sixty days to be paid, which keeps them poor even when demand for their crops is high.",
  "We launched eighteen months ago in Lagos and Ogun state, we now work with two thousand four hundred farmers and one hundred and ten business buyers, and we processed one point two million dollars of orders last year.",
  "We take an eight percent commission on every order and we also charge a delivery fee, our gross margin is thirty one percent and it has improved every quarter as our delivery routes get denser.",
  "Our main competitors are informal market agents and a few logistics startups, but none of them combine payment within forty eight hours, cold chain delivery and demand forecasting for the farmer.",
  "My co-founder ran supply chain at a large retailer for nine years, our technical lead built payment systems at a fintech, and I grew up on a cassava farm, so we understand both sides of this market.",
  "That is a fair question, it costs us about eleven dollars to acquire a farmer through cooperatives, and we earn that back in under four months because farmers sell through us every week.",
  "The biggest risk is delivery cost in the rainy season, so we partner with local transport cooperatives and keep a buffer in our pricing to protect margins when the roads are difficult.",
  "We are raising one point five million dollars at seed to expand to three more states, build our forecasting product and reach ten thousand farmers within the next eighteen months."
)

$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000,
  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono
)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $path = Join-Path $OutDir ("founder-{0:D2}.wav" -f $i)
    $synth.SetOutputToWaveFile($path, $format)
    $synth.Speak($lines[$i])
    $synth.SetOutputToNull()
    $seconds = [math]::Round(((Get-Item $path).Length - 44) / 32000, 1)
    Write-Output ("{0}  {1}s" -f (Split-Path $path -Leaf), $seconds)
  }
} finally {
  $synth.Dispose()
}
