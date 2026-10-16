(module
  ;; Browser geometry is deliberately small and deterministic. JavaScript calls
  ;; these functions for grid alignment and freehand path simplification.
  (func (export "snap_grid") (param $value f64) (param $grid f64) (result f64)
    (f64.mul
      (f64.floor (f64.add (f64.div (local.get $value) (local.get $grid)) (f64.const 0.5)))
      (local.get $grid)))

  (func (export "point_segment_distance_sq")
    (param $px f64) (param $py f64)
    (param $ax f64) (param $ay f64)
    (param $bx f64) (param $by f64)
    (result f64)
    (local $dx f64) (local $dy f64) (local $length_sq f64)
    (local $t f64) (local $ex f64) (local $ey f64)
    (local.set $dx (f64.sub (local.get $bx) (local.get $ax)))
    (local.set $dy (f64.sub (local.get $by) (local.get $ay)))
    (local.set $length_sq
      (f64.add
        (f64.mul (local.get $dx) (local.get $dx))
        (f64.mul (local.get $dy) (local.get $dy))))
    (if (f64.gt (local.get $length_sq) (f64.const 0))
      (then
        (local.set $t
          (f64.div
            (f64.add
              (f64.mul (f64.sub (local.get $px) (local.get $ax)) (local.get $dx))
              (f64.mul (f64.sub (local.get $py) (local.get $ay)) (local.get $dy)))
            (local.get $length_sq)))
        (local.set $t (f64.min (f64.const 1) (f64.max (f64.const 0) (local.get $t))))))
    (local.set $ex
      (f64.sub (local.get $px) (f64.add (local.get $ax) (f64.mul (local.get $t) (local.get $dx)))))
    (local.set $ey
      (f64.sub (local.get $py) (f64.add (local.get $ay) (f64.mul (local.get $t) (local.get $dy)))))
    (f64.add (f64.mul (local.get $ex) (local.get $ex)) (f64.mul (local.get $ey) (local.get $ey))))

  (func (export "point_in_box")
    (param $px f64) (param $py f64)
    (param $x f64) (param $y f64) (param $width f64) (param $height f64)
    (result i32)
    (i32.and
      (i32.and
        (f64.ge (local.get $px) (f64.min (local.get $x) (f64.add (local.get $x) (local.get $width))))
        (f64.le (local.get $px) (f64.max (local.get $x) (f64.add (local.get $x) (local.get $width)))))
      (i32.and
        (f64.ge (local.get $py) (f64.min (local.get $y) (f64.add (local.get $y) (local.get $height))))
        (f64.le (local.get $py) (f64.max (local.get $y) (f64.add (local.get $y) (local.get $height))))))))
