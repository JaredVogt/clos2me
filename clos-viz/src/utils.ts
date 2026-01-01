export function portToProPatch(port: number): string {
  // Overlap zone 85-88: H5-H8 and P1-P4
  if (port >= 85 && port <= 88) {
    const hNum = port - 80 // H5-H8
    const pNum = port - 84 // P1-P4
    return `H${hNum}/P${pNum}(${port})`
  }

  // P5-P16 for ports 89-100
  if (port >= 89 && port <= 100) {
    return `P${port - 84}(${port})`
  }

  // H1-H4 for ports 81-84
  if (port >= 81 && port <= 84) {
    return `H${port - 80}(${port})`
  }

  // A-J with 8 ports each for 1-80
  if (port >= 1 && port <= 80) {
    const letterIndex = Math.floor((port - 1) / 8)
    const portNum = ((port - 1) % 8) + 1
    const letter = String.fromCharCode(65 + letterIndex) // 65 = 'A'
    return `${letter}${portNum}(${port})`
  }

  // Fallback for out of range
  return String(port)
}

// Extract numerical port ID from ProPatch label like "A1(1)" -> 1
export function parsePortId(label: string): number {
  const match = label.match(/\((\d+)\)/)
  return match ? parseInt(match[1]) : parseInt(label)
}
