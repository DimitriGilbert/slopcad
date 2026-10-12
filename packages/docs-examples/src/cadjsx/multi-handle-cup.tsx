import { Body, Circle, Line, Revolve, Sketch, Union } from "@slopcad/cad-jsx";

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const HANDLE_COUNT = 6;
const HANDLE_RADIAL = 40;
const HANDLE_Z = 30;
const HANDLE_MAJOR = 9;
const HANDLE_MINOR = 3;

interface HandleSpec {
  readonly angle: number;
  readonly sketchId: string;
  readonly featureId: string;
  readonly origin: { x: number; y: number; z: number };
  readonly normal: { x: number; y: number; z: number };
  readonly xAxis: { x: number; y: number; z: number };
}

/**
 * A tapered, hollow cup with six loop handles.
 * The cup is one revolved L-profile about world +z; each handle is a torus
 * (a circle revolved about a tangent axis through its own sketch origin),
 * embedded into the wall so the union welds them on.
 */
export function MultiHandleCup(): React.JSX.Element {
  const handles: HandleSpec[] = Array.from({ length: HANDLE_COUNT }, (_, i) => {
    const angle = (i * TAU) / HANDLE_COUNT;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
      angle,
      sketchId: `skd_handle-${i + 1}`,
      featureId: `feat_handle-${i + 1}`,
      origin: {
        x: HANDLE_RADIAL * c,
        y: HANDLE_RADIAL * s,
        z: HANDLE_Z,
      },
      normal: { x: c, y: s, z: 0 },
      xAxis: { x: -s, y: c, z: 0 },
    };
  });

  return (
    <>
      <Sketch
        id="skd_cup-profile"
        name="cup profile"
        normal={{ x: 1, y: 0, z: 0 }}
        xAxis={{ x: 0, y: 1, z: 0 }}
      >
        <Line x1={0} y1={0} x2={30} y2={0} />
        <Line x1={30} y1={0} x2={40} y2={50} />
        <Line x1={40} y1={50} x2={37} y2={50} />
        <Line x1={37} y1={50} x2={27} y2={3} />
        <Line x1={27} y1={3} x2={0} y2={3} />
        <Line x1={0} y1={3} x2={0} y2={0} />
      </Sketch>
      {handles.map((h) => (
        <Sketch
          key={h.sketchId}
          id={h.sketchId}
          name={`handle loop ${h.angle}`}
          origin={h.origin}
          normal={h.normal}
          xAxis={h.xAxis}
        >
          <Circle cx={0} cy={-HANDLE_MAJOR} radius={HANDLE_MINOR} />
        </Sketch>
      ))}
      <Body id="body_cup" name="cup">
        <Union id="feat_cup">
          <Revolve
            id="feat_cup-body"
            sketch="skd_cup-profile"
            angle={TAU}
            axis={HALF_PI}
          />
          {handles.map((h) => (
            <Revolve
              key={h.featureId}
              id={h.featureId}
              sketch={h.sketchId}
              angle={TAU}
              axis={0}
            />
          ))}
        </Union>
      </Body>
    </>
  );
}

export default <MultiHandleCup />;
